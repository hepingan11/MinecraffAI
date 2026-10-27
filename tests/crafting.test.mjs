import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { registerCraftingTools } from "../minecraft-crafting-tools.mjs";
import { craftItem, getCraftingRecipes, getInventory } from "../minecraft-mod-api.mjs";
import { ToolRegistry } from "../tool-registry.mjs";
import { EventQueue } from "../event-queue.mjs";
import { MinecraftEventSource } from "../minecraft-event-source.mjs";
import { TaskStateStore } from "../task-state.mjs";
import { AutoReplyService, DEFAULT_CONFIG } from "../auto-reply.mjs";

const dimension = "minecraft:overworld";
const id = "00000000-0000-4000-8000-000000000007";
const plank = { itemId: "minecraft:oak_planks", recipeId: 7, outputPerCraft: 4, ingredientSlots: [["minecraft:oak_log"]], station: "inventory" };
const stick = { itemId: "minecraft:stick", recipeId: 8, outputPerCraft: 4, ingredientSlots: [["minecraft:oak_planks"], ["minecraft:oak_planks"]], station: "inventory" };

// This double implements a tiny server inventory so tests can check that the
// production Node/ReAct stack waits for results and does not duplicate requests.
async function modDouble(t, { rejectStart = null, hold = false, cleanupFailure = false, onStart = null } = {}) {
  const requests = [];
  const inventory = { "minecraft:oak_log": 1 };
  let live, pending, phase = 0, stopping = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer craft-test");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ path: req.url, body });
    let value = { ok: true };
    if (req.url === "/health") value = { ok: true, connected: true, craftingVersion: 1 };
    else if (req.url === "/inventory") value.items = Object.entries(inventory).filter(([, count]) => count > 0).map(([itemId, count]) => ({ itemId, count }));
    else if (req.url === "/state") value.craft = live;
    else if (["/environment", "/mining/status", "/follow/status"].includes(req.url)) value.status = "idle";
    else if (req.url === "/craft/recipes") {
      const recipe = body.itemId === plank.itemId ? plank : body.itemId === stick.itemId ? stick : null;
      value = { ok: true, dimension, source: "server_recipe_book", craftingTableAvailable: false, recipes: recipe ? [{ ...recipe, craftable: true }] : [] };
    } else if (req.url === "/craft/start") {
      if (rejectStart) { res.statusCode = 400; value = { ok: false, error: rejectStart }; }
      else {
        const recipe = body.itemId === plank.itemId ? plank : stick;
        const crafts = Math.ceil(body.quantity / recipe.outputPerCraft);
        pending = { recipe, crafts }; phase = 0;
        live = { id, itemId: recipe.itemId, requestedQuantity: body.quantity, expectedOutput: crafts * 4, inventoryBefore: inventory[recipe.itemId] || 0, state: "preparing", active: true, produced: 0, recoveryRequired: false };
        onStart?.();
        value.craft = live;
      }
    } else if (req.url === "/craft/status") {
      if (stopping && cleanupFailure) live = { ...live, active: false, state: "error", produced: 4, recoveryRequired: true, message: "剩余材料未安全回收" };
      else if (live?.active && !hold) {
        const states = ["waiting_recipe", "verifying", "cleanup", "completed"];
        const state = states[Math.min(phase++, 3)];
        if (state === "completed") {
          const { recipe, crafts } = pending;
          if (recipe === plank) inventory["minecraft:oak_log"] -= crafts;
          else inventory[plank.itemId] -= crafts * 2;
          inventory[recipe.itemId] = (inventory[recipe.itemId] || 0) + crafts * 4;
        }
        live = { ...live, state, active: state !== "completed", produced: state === "completed" ? live.expectedOutput : 0,
          ...(state === "completed" ? { inventoryAfter: inventory[live.itemId] } : {}) };
      }
      value.craft = live;
    } else if (req.url === "/craft/stop") {
      assert.equal(body.taskId, id);
      stopping = true;
      live = { ...live, active: cleanupFailure, state: cleanupFailure ? "cleanup" : "cancelled", message: "cancelled without replay" }; value.craft = live;
    } else { res.statusCode = 404; value = { ok: false, error: "not found" }; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { window: { id: "craft-window", host: "127.0.0.1", port: server.address().port, token: "craft-test" }, requests, inventory };
}

async function taskStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-craft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStateStore(path.join(dir, "tasks.json")); await store.load();
  return store;
}

test("craft arguments are rejected before HTTP, including unknown permissions and invalid counts", async (t) => {
  const { window, requests } = await modDouble(t);
  const registry = registerCraftingTools(new ToolRegistry());
  for (const args of [
    {}, { itemId: plank.itemId }, { itemId: plank.itemId, dimension, quantity: 0 },
    { itemId: plank.itemId, dimension, quantity: 65 }, { itemId: plank.itemId, dimension, quantity: "1" },
    { itemId: plank.itemId, dimension, quantity: 1.5 }, { itemId: plank.itemId, dimension, recipeId: -1 },
    { itemId: plank.itemId, dimension, ignoreSafety: true }, { itemId: "/give player planks", dimension },
  ]) assert.equal((await registry.invoke("minecraft_craft", args, { window })).ok, false);
  await assert.rejects(() => getCraftingRecipes(window, { itemId: plank.itemId, maxResults: 33 }));
  assert.throws(() => craftItem(window, { itemId: plank.itemId, dimension, quantity: NaN }));
  assert.equal(requests.length, 0);
});

test("recipe query returns native recipe metadata and supports an empty unlocked list", async (t) => {
  const { window, requests } = await modDouble(t);
  const result = await getCraftingRecipes(window, { itemId: plank.itemId });
  assert.equal(result.source, "server_recipe_book");
  assert.deepEqual(result.recipes[0].ingredientSlots, [["minecraft:oak_log"]]);
  assert.deepEqual(requests[0].body, { itemId: plank.itemId, quantity: 1, maxResults: 16 });
  assert.deepEqual((await getCraftingRecipes(window, { itemId: "minecraft:unknown" })).recipes, []);
});

test("craft waits through filling, verification and cleanup, then persists rounded production", async (t) => {
  const { window, requests } = await modDouble(t);
  const store = await taskStore(t);
  const registry = registerCraftingTools(new ToolRegistry(), { taskState: store });
  const result = await registry.invoke("minecraft_craft", { itemId: plank.itemId, dimension, quantity: 3 }, { window });
  assert.equal(result.ok, true); assert.equal(result.craft.produced, 4);
  assert.equal(result.craft.inventoryAfter - result.craft.inventoryBefore, 4);
  assert.equal(requests.filter((r) => r.path === "/craft/start").length, 1);
  assert.equal(requests.filter((r) => r.path === "/craft/status").length, 4);
  const task = store.get(result.taskId);
  assert.equal(task.kind, "craft"); assert.equal(task.status, "succeeded");
  assert.equal(task.progress.produced, 4); assert.equal(task.resumePolicy, "never");
  assert.equal(store.resumable().length, 0);
});

test("material, station, inventory and stale-recipe errors are reported without automatic retry", async (t) => {
  for (const reason of ["材料不足", "需要工作台", "背包空间不足", "配方未解锁或已失效"]) {
    const { window, requests } = await modDouble(t, { rejectStart: reason });
    const registry = registerCraftingTools(new ToolRegistry());
    const result = await registry.invoke("minecraft_craft", { itemId: plank.itemId, dimension }, { window });
    assert.equal(result.ok, false); assert.equal(result.executionError, reason);
    assert.deepEqual(requests.map((r) => r.path), ["/craft/start"]);
  }
});

test("craft cancellation is sent to the owning operation and does not replay it", async (t) => {
  const { window, requests } = await modDouble(t, { hold: true });
  const controller = new AbortController();
  await assert.rejects(() => craftItem(window, { itemId: plank.itemId, dimension }, {
    signal: controller.signal, onStarted: () => controller.abort("test cancel"),
  }), /取消/u);
  assert.deepEqual(requests.map((r) => r.path), ["/craft/start", "/craft/stop"]);
  assert.equal(requests[1].body.taskId, id);
});

test("craft events correlate by operation ID and preserve partial production on failure", async (t) => {
  const queue = new EventQueue(); const source = new MinecraftEventSource({ queue });
  const store = await taskStore(t);
  const task = await store.create({ kind: "craft", windowId: "one", resumePolicy: "never" });
  await store.markStarted(task.id); await store.update(task.id, { progress: { operationId: id } });
  const live = { id, active: false, state: "error", produced: 4, requestedQuantity: 8, recoveryRequired: true, message: "材料已改变" };
  source.publishObservation({ id: "one" }, { state: { craft: live } });
  const event = queue.recent(100).find((e) => e.type === "minecraft.task" && e.data.kind === "craft");
  assert.equal(event.data.current.produced, 4);
  await store.reconcileObservation("one", { state: { craft: { ...live, id: "different" } } });
  assert.equal(store.get(task.id).status, "running");
  await store.reconcileObservation("one", { state: { craft: live } });
  assert.equal(store.get(task.id).status, "failed"); assert.equal(store.get(task.id).progress.recoveryRequired, true);
  assert.equal(store.resumable().length, 0);
});

test("cancellation cleanup failures remain failures and retain partial production", async (t) => {
  const controller = new AbortController();
  const { window, requests } = await modDouble(t, { hold: true, cleanupFailure: true, onStart: () => controller.abort("cancel during fill") });
  const store = await taskStore(t);
  const registry = registerCraftingTools(new ToolRegistry(), { taskState: store });
  const result = await registry.invoke("minecraft_craft", { itemId: plank.itemId, dimension }, { window, signal: controller.signal });
  assert.equal(result.ok, false); assert.equal(result.craft.state, "error");
  assert.equal(result.craft.recoveryRequired, true); assert.equal(result.craft.produced, 4);
  assert.equal(store.get(result.taskId).status, "failed");
  assert.deepEqual(requests.map((r) => r.path), ["/craft/start", "/craft/stop", "/craft/status"]);
});

test("ReAct can craft prerequisite planks, then sticks, and check the final inventory", async (t) => {
  const { window, inventory } = await modDouble(t);
  const registry = registerCraftingTools(new ToolRegistry());
  registry.register({ name: "minecraft_inventory", description: "inventory", readOnly: true, handler: (_, c) => getInventory(c.window) });
  const calls = [
    ["minecraft_recipes", { itemId: plank.itemId }], ["minecraft_craft", { itemId: plank.itemId, quantity: 4, dimension }],
    ["minecraft_recipes", { itemId: stick.itemId }], ["minecraft_craft", { itemId: stick.itemId, quantity: 3, dimension }],
    ["minecraft_inventory", {}],
  ];
  let round = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    const payload = JSON.parse(options.body);
    if (round) {
      const prior = JSON.parse(payload.messages.at(-1).content);
      assert.equal(prior.ok, true);
      if ([2, 4].includes(round)) assert.equal(prior.craft.state, "completed");
      if (round === 5) assert.equal(prior.items.find((item) => item.itemId === stick.itemId).count, 4);
    }
    const call = calls[round++];
    const message = call ? { role: "assistant", content: null, tool_calls: [{ id: `craft-${round}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { role: "assistant", content: "已合成 4 根木棍，背包还剩 2 块木板。" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const service = new AutoReplyService({ toolRegistry: registry });
  service.config = { ...DEFAULT_CONFIG, apiKey: "test-model", maxToolRounds: 8 };
  assert.equal(await service.generateReply("用原木做三根木棍", window), "已合成 4 根木棍，背包还剩 2 块木板。");
  assert.equal(round, 6); assert.equal(inventory[plank.itemId], 2); assert.equal(inventory[stick.itemId], 4);
});

test("production dashboard exposes crafting HTTP endpoints and requires an explicit window", async (t) => {
  const { window } = await modDouble(t);
  const store = await taskStore(t); const dir = path.dirname(store.filePath);
  await writeFile(path.join(dir, "one.json"), JSON.stringify(window), "utf8");
  await writeFile(path.join(dir, "two.json"), JSON.stringify({ ...window, id: "second-window" }), "utf8");
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["minecraft-dashboard.mjs"], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MC_DASHBOARD_PORT: String(port), MC_AI_REGISTRY_DIR: dir, MC_AI_CONFIG_PATH: path.join(dir, "config.json"),
      MC_AI_TASKS_PATH: store.filePath, MC_AI_KNOWLEDGE_PATH: path.join(dir, "knowledge.json"), MC_AI_EXPERIENCE_PATH: path.join(dir, "experience.json") } });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const tools = (await api("/api/tools")).data.tools;
  assert.equal(tools.find((tool) => tool.name === "minecraft_recipes").readOnly, true);
  assert.equal(tools.find((tool) => tool.name === "minecraft_craft").readOnly, false);
  assert.equal((await api("/api/skills/minecraft_craft")).status, 405);
  assert.match((await api("/api/skills/minecraft_recipes", { itemId: plank.itemId })).data.error, /多个/u);
  const queried = await api("/api/skills/minecraft_recipes", { windowId: window.id, itemId: plank.itemId });
  assert.equal(queried.data.recipes[0].recipeId, 7);
  const crafted = await api("/api/skills/minecraft_craft", { windowId: window.id, itemId: plank.itemId, dimension });
  assert.equal(crafted.status, 200); assert.equal(crafted.data.craft.produced, 4);
  const task = (await api("/api/tasks")).data.tasks.find((item) => item.id === crafted.data.taskId);
  assert.equal(task.status, "succeeded"); assert.equal(task.resumePolicy, "never");
});
