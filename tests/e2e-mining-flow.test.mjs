import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { AutoReplyService, DEFAULT_CONFIG } from "../auto-reply.mjs";
import { EventQueue } from "../event-queue.mjs";
import { getEnvironment, getInventory, getObservation, getFollowStatus, getMiningStatus, startMining, validateMiningPlan } from "../minecraft-mod-api.mjs";
import { ToolRegistry } from "../tool-registry.mjs";

const pickaxe = { slot: 0, itemId: "minecraft:iron_pickaxe", name: "Iron Pickaxe", count: 1, damage: 0, maxDamage: 250, broken: false };

test("e2e: 用户要求挖铁矿时完成观察、背包预检、工具执行和结果回写", async (t) => {
  const requests = [];
  let mining = { state: "idle", active: false, message: "没有正在执行的挖矿任务" };
  const mod = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer e2e-token");
    requests.push(req.url);
    let body = "";
    for await (const chunk of req) body += chunk;
    let value;
    if (req.url === "/state") value = { ok: true, activity: mining.active ? "mining" : "idle", player: "Steve" };
    else if (req.url === "/environment") value = { ok: true, dimension: "minecraft:overworld", position: { x: 10, y: 64, z: 10 }, blocks: [] };
    else if (req.url === "/follow/status") value = { ok: true, follow: { state: "idle", active: false } };
    else if (req.url === "/inventory") value = { ok: true, selectedSlot: 0, miningToolSelection: "pickaxe_priority_v1", items: [pickaxe] };
    else if (req.url === "/mining/status") value = { ok: true, status: mining.state, mining };
    else if (req.url === "/mining/start") {
      const plan = JSON.parse(body);
      assert.deepEqual(plan.targetBlocks, ["minecraft:iron_ore"]);
      assert.equal(plan.quantity, 1);
      mining = { state: "equipping", active: true, selectedTool: pickaxe, targetBlocks: plan.targetBlocks, broken: 0, message: "正在装备铁镐" };
      value = { ok: true, status: mining.state, mining };
    } else {
      res.statusCode = 404;
      value = { ok: false, error: `unexpected endpoint ${req.url}` };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  mod.listen(0, "127.0.0.1");
  await once(mod, "listening");
  t.after(() => new Promise((resolve) => mod.close(resolve)));
  const window = { id: "e2e-window", host: "127.0.0.1", port: mod.address().port, token: "e2e-token" };

  const registry = new ToolRegistry();
  registry
    .register({ name: "minecraft_observe", description: "observe", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, handler: (_args, context) => getObservation(context.window) })
    .register({ name: "minecraft_inventory", description: "inventory", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, handler: (_args, context) => getInventory(context.window) })
    .register({
      name: "minecraft_mining",
      description: "start mining",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start"] },
          targetBlocks: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", pattern: "^minecraft:[a-z0-9_./-]+$" } },
          quantity: { type: "integer", minimum: 1, maximum: 256 },
        },
        required: ["targetBlocks", "quantity"],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const plan = validateMiningPlan({ ...args, action: undefined, maxMinutes: 1, maxBlocks: 8 });
        const started = await startMining(context.window, plan);
        return { started, status: await getMiningStatus(context.window) };
      },
    });

  const events = new EventQueue();
  const eventTrace = [];
  events.subscribe((event) => eventTrace.push({ type: event.type, name: event.data?.name || null, state: event.data?.result?.status?.mining?.state || null }));
  const requestsToModel = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requestsToModel.push(payload);
    const round = requestsToModel.length;
    const responses = {
      1: { role: "assistant", content: null, tool_calls: [{ id: "observe-1", type: "function", function: { name: "minecraft_observe", arguments: "{}" } }] },
      2: { role: "assistant", content: null, tool_calls: [{ id: "inventory-1", type: "function", function: { name: "minecraft_inventory", arguments: "{}" } }] },
      3: { role: "assistant", content: null, tool_calls: [{ id: "mining-1", type: "function", function: { name: "minecraft_mining", arguments: JSON.stringify({ action: "start", targetBlocks: ["minecraft:iron_ore"], quantity: 1 }) } }] },
      4: { role: "assistant", content: "已完成观察和背包预检，已装备铁镐并启动铁矿任务；当前状态是 equipping。", tool_calls: [] },
    };
    assert.equal(payload.tools.length, 3);
    const message = responses[round];
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  try {
    const service = new AutoReplyService({ toolRegistry: registry, eventQueue: events });
    service.config = { ...DEFAULT_CONFIG, apiKey: "e2e-model-key", maxToolRounds: 4 };
    const reply = await service.generateReply("去挖铁矿", window);
    assert.match(reply, /启动铁矿任务/u);
    assert.deepEqual(service.status.lastSkills, ["minecraft_observe", "minecraft_inventory", "minecraft_mining"]);
    assert.deepEqual(requests, ["/state", "/environment", "/mining/status", "/follow/status", "/inventory", "/inventory", "/mining/start", "/mining/status"]);
    assert.equal(requestsToModel.length, 4);
    assert.equal(requestsToModel[1].messages.at(-1).role, "tool");
    assert.equal(requestsToModel[2].messages.at(-1).role, "tool");
    assert.equal(requestsToModel[3].messages.at(-1).role, "tool");
    assert.deepEqual(eventTrace.map((event) => event.type), [
      "agent.tool_call", "agent.tool_started", "agent.tool_result",
      "agent.tool_call", "agent.tool_started", "agent.tool_result",
      "agent.tool_call", "agent.tool_started", "agent.tool_result",
    ]);
    console.log(JSON.stringify({
      example: "去挖铁矿",
      modelRounds: requestsToModel.length,
      toolOrder: service.status.lastSkills,
      modRequests: requests,
      eventOrder: eventTrace.map((event) => event.type),
      selectedTool: pickaxe.itemId,
      miningState: mining.state,
      reply,
    }, null, 2));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
