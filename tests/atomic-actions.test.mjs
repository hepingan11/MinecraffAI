import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { registerAtomicTools } from "../minecraft-atomic-tools.mjs";
import { scanBlocks, getInventory, breakBlock } from "../minecraft-mod-api.mjs";
import { ToolRegistry } from "../tool-registry.mjs";
import { ToolExecutor } from "../tool-executor.mjs";
import { TaskStateStore } from "../task-state.mjs";
import { EventQueue } from "../event-queue.mjs";
import { MinecraftEventSource } from "../minecraft-event-source.mjs";
import { AutoReplyService, DEFAULT_CONFIG } from "../auto-reply.mjs";

const dimension = "minecraft:overworld";
const target = { x: 10, y: 64, z: 10, dimension };
const blockArgs = { ...target, expectedBlockId: "minecraft:iron_ore" };
const operationId = "00000000-0000-4000-8000-000000000001";

async function fakeMod(t, { hold = false, state = "completed" } = {}) {
  const requests = [];
  let live = null, kind = null, mined = false, moved = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    requests.push({ path: req.url, body });
    let value = { ok: true };
    if (req.url === "/health") value = { ok: true, connected: true };
    else if (req.url === "/blocks/scan") value = { ok: true, dimension, blocks: [{ ...target, blockId: "minecraft:iron_ore", visible: true, inReach: moved }] };
    else if (req.url === "/inventory") value = { ok: true, items: [{ itemId: "minecraft:iron_pickaxe", count: 1 }, ...(mined ? [{ itemId: "minecraft:raw_iron", count: 1 }] : [])] };
    else if (["/move/start", "/blocks/break", "/blocks/place"].includes(req.url)) {
      kind = req.url === "/move/start" ? "move" : "action";
      live = { id: operationId, state: "running", active: true, position: target };
      value = { ok: true, [kind]: live };
    } else if (req.url.endsWith("/stop")) {
      assert.equal(body.taskId, operationId);
      live = { ...live, state: "cancelled", active: false };
      value = { ok: true, [kind]: live };
    } else if (req.url.endsWith("/status")) {
      if (!hold) {
        live = { ...live, state, active: false, changed: kind === "action" && state === "completed", message: state === "completed" ? "done" : "no safe path" };
        if (kind === "move") moved = true;
        else mined = state === "completed";
      }
      value = { ok: true, [kind]: live };
    } else {
      res.statusCode = 404; value = { ok: false, error: "missing" };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, window: { id: "test-window", host: "127.0.0.1", port: server.address().port, token: "test-token" } };
}

test("atomic backend rejects invalid direct arguments and model arguments before HTTP", async (t) => {
  const { window, requests } = await fakeMod(t);
  const registry = registerAtomicTools(new ToolRegistry());
  for (const [name, args] of [
    ["minecraft_scan_blocks", { radius: 17 }],
    ["minecraft_scan_blocks", { radius: "8" }],
    ["minecraft_scan_blocks", { x: 1 }],
    ["minecraft_break_block", { ...target }],
    ["minecraft_break_block", { ...blockArgs, x: 1.5 }],
    ["minecraft_move_to", { ...target, distance: 20 }],
    ["minecraft_place_block", { ...target, itemId: "minecraft:stone", face: "inside" }],
    ["minecraft_place_block", { ...target, itemId: "minecraft:stone", ignoreSafety: true }],
  ]) assert.equal((await registry.invoke(name, args, { window })).ok, false);
  await assert.rejects(() => scanBlocks(window, { radius: Infinity }));
  assert.throws(() => breakBlock(window, { ...blockArgs, y: 321 }));
  assert.equal(requests.length, 0);
});

test("atomic move returns terminal failure rather than a successful start", async (t) => {
  const { window } = await fakeMod(t, { state: "stuck" });
  const registry = registerAtomicTools(new ToolRegistry());
  const result = await registry.invoke("minecraft_move_to", target, { window });
  assert.equal(result.ok, false);
  assert.equal(result.move.state, "stuck");
  assert.match(result.executionError, /no safe path/u);
});

test("cancellation stops the specific physical operation", async (t) => {
  const { window, requests } = await fakeMod(t, { hold: true });
  const controller = new AbortController();
  await assert.rejects(() => breakBlock(window, blockArgs, {
    signal: controller.signal,
    onStarted: () => controller.abort("cancel test"),
  }), /取消/u);
  assert.deepEqual(requests.map((r) => r.path), ["/blocks/break", "/blocks/stop"]);
  assert.equal(requests[1].body.taskId, operationId);
});

test("urgent events from another Minecraft window cannot cancel this window's tool", async (t) => {
  const { window } = await fakeMod(t);
  const registry = registerAtomicTools(new ToolRegistry());
  const executor = new ToolExecutor({ registry });
  const result = await executor.run([{ id: "move", name: "minecraft_move_to", arguments: target }], { window }, {
    started: () => assert.equal(executor.arrived({ type: "minecraft.error", windowId: "another-window" }, true), false),
  });
  assert.equal(result[0].result.move.state, "completed");
});

test("place waits for observed completion and tracks durable task results", async (t) => {
  const { window, requests } = await fakeMod(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStateStore(path.join(dir, "tasks.json"));
  await store.load();
  const registry = registerAtomicTools(new ToolRegistry(), { taskState: store });
  const result = await registry.invoke("minecraft_place_block", { ...target, itemId: "minecraft:cobblestone" }, { window });
  assert.equal(result.action.changed, true);
  assert.deepEqual(requests.map((r) => r.path), ["/blocks/place", "/blocks/status"]);
  assert.equal(store.get(result.taskId).status, "succeeded");
  assert.equal(store.get(result.taskId).resumePolicy, "never");
  await store.reconcileObservation(window.id, { state: { action: { id: operationId, active: true, state: "running" } } });
  assert.equal(store.get(result.taskId).status, "succeeded", "stale snapshots cannot revive completed actions");
});

test("atomic completion events do not interrupt the awaited tool that completed", () => {
  const queue = new EventQueue();
  const source = new MinecraftEventSource({ queue });
  source.publishObservation({ id: "one" }, { state: { move: { id: operationId, state: "moving", active: true } } });
  source.publishObservation({ id: "one" }, { state: { move: { id: operationId, state: "completed", active: false } } });
  const event = queue.recent(100).find((e) => e.type === "minecraft.task" && e.data.kind === "move" && e.data.current.state === "completed");
  assert.equal(event.urgent, false);
});

test("concurrent task updates persist safely and correlate observations by operation ID", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-atomic-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStateStore(path.join(dir, "tasks.json"));
  await store.load();
  const tasks = await Promise.all(Array.from({ length: 8 }, (_, n) => store.create({ id: `atomic-${n}`, kind: "move", windowId: "one" })));
  await store.markStarted(tasks[0].id);
  await store.update(tasks[0].id, { progress: { operationId } });
  await store.reconcileObservation("one", { state: { move: { id: "different-operation", active: false, state: "completed" } } });
  assert.equal(store.get(tasks[0].id).status, "running");
  await store.reconcileObservation("one", { state: { move: { id: operationId, active: false, state: "completed" } } });
  const reloaded = new TaskStateStore(store.filePath);
  await reloaded.load();
  assert.equal(reloaded.list().length, 8);
  assert.equal(reloaded.get(tasks[0].id).status, "succeeded");
});

test("ReAct example: inventory -> scan -> move -> rescan -> break -> inventory -> model", async (t) => {
  const { window, requests } = await fakeMod(t);
  const registry = registerAtomicTools(new ToolRegistry());
  registry.register({ name: "minecraft_inventory", description: "inventory", readOnly: true, handler: (_, c) => getInventory(c.window) });
  const calls = [
    ["minecraft_inventory", {}], ["minecraft_scan_blocks", { blocks: ["minecraft:iron_ore"] }],
    ["minecraft_move_to", { ...target, distance: 2 }], ["minecraft_scan_blocks", { blocks: ["minecraft:iron_ore"] }],
    ["minecraft_break_block", blockArgs], ["minecraft_inventory", {}],
  ];
  let round = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (round) {
      const result = JSON.parse(payload.messages.at(-1).content);
      assert.equal(result.ok, true);
      if (round === 3) assert.equal(result.move.state, "completed");
      if (round === 5) assert.equal(result.action.changed, true);
      if (round === 6) assert.equal(result.items.find((i) => i.itemId === "minecraft:raw_iron").count, 1);
    }
    const call = calls[round++];
    const message = call ? { role: "assistant", content: null, tool_calls: [{ id: `call-${round}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { role: "assistant", content: "背包已确认增加 1 个粗铁。" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const queue = new EventQueue();
  const service = new AutoReplyService({ toolRegistry: registry, toolExecutor: new ToolExecutor({ registry }), eventQueue: queue });
  service.config = { ...DEFAULT_CONFIG, apiKey: "fake-model", maxToolRounds: 8 };
  assert.equal(await service.generateReply("挖一块铁矿并检查背包", window), "背包已确认增加 1 个粗铁。");
  assert.equal(round, 7);
  assert.deepEqual(requests.map((r) => r.path), ["/inventory", "/blocks/scan", "/move/start", "/move/status", "/blocks/scan", "/blocks/break", "/blocks/status", "/inventory"]);
  assert.equal(queue.recent(100).filter((e) => e.type === "agent.tool_result").length, 6);
});

test("production dashboard exposes atomic tools and enforces window selection and parameters", async (t) => {
  const { window } = await fakeMod(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-atomic-dashboard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "one.json"), JSON.stringify(window), "utf8");
  await writeFile(path.join(dir, "two.json"), JSON.stringify({ ...window, id: "another-window" }), "utf8");
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["minecraft-dashboard.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MC_DASHBOARD_PORT: String(port), MC_AI_REGISTRY_DIR: dir,
      MC_AI_CONFIG_PATH: path.join(dir, "config.json"), MC_AI_TASKS_PATH: path.join(dir, "tasks.json"),
      MC_AI_KNOWLEDGE_PATH: path.join(dir, "knowledge.json"), MC_AI_EXPERIENCE_PATH: path.join(dir, "experience.json") },
  });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const tools = (await api("/api/tools")).data.tools;
  assert.equal(tools.filter((tool) => ["minecraft_scan_blocks", "minecraft_move_to", "minecraft_break_block", "minecraft_place_block"].includes(tool.name)).length, 4);
  assert.equal((await api("/api/skills/minecraft_scan_blocks")).status, 405);
  assert.match((await api("/api/skills/minecraft_scan_blocks", {})).data.error, /多个/u);
  assert.equal((await api("/api/skills/minecraft_scan_blocks", { windowId: window.id, radius: 100 })).status, 400);
  const result = await api("/api/skills/minecraft_scan_blocks", { windowId: window.id, blocks: ["minecraft:iron_ore"] });
  assert.equal(result.status, 200);
  assert.equal(result.data.blocks[0].blockId, "minecraft:iron_ore");
});
