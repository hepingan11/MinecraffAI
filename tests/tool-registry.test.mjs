import test from "node:test";
import assert from "node:assert/strict";
import { AutoReplyService, DEFAULT_CONFIG } from "../auto-reply.mjs";
import { ToolRegistry } from "../tool-registry.mjs";

test("ToolRegistry exposes schemas and executes only backend handlers", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "minecraft_inventory",
    description: "Read inventory",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    handler: async (args, context) => {
      calls.push({ args, context });
      return { ok: true, items: [] };
    },
  });

  assert.deepEqual(registry.definitions(), [{
    type: "function",
    function: {
      name: "minecraft_inventory",
      description: "Read inventory",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  }]);
  assert.deepEqual(await registry.invoke("minecraft_inventory", "{}", { window: { id: "1" } }), { ok: true, items: [] });
  assert.equal(calls[0].context.readOnly, true);
  const invalidArguments = await registry.invoke("minecraft_inventory", "not-json");
  assert.equal(invalidArguments.ok, false);
  assert.match(invalidArguments.executionError, /工具参数不是有效 JSON/u);
  await assert.rejects(() => registry.invoke("unknown", {}), /未知工具/u);
});

test("AutoReplyService runs a native tool call and sends its result back to the model", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "minecraft_inventory",
    description: "Read inventory",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, context) => ({ ok: true, windowId: context.window.id, inventory: { items: [] } }),
  });
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const body = requests.length === 1
      ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "minecraft_inventory", arguments: "{}" } }] } }] }
      : { choices: [{ message: { role: "assistant", content: "背包是空的。", tool_calls: [] } }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const service = new AutoReplyService({ toolRegistry: registry });
    service.config = { ...DEFAULT_CONFIG, apiKey: "test-key", maxToolRounds: 2 };
    const reply = await service.generateReply("查一下背包", { id: "window-1" });
    assert.equal(reply, "背包是空的。");
    assert.deepEqual(service.status.lastSkills, ["minecraft_inventory"]);
    assert.deepEqual(requests[0].tools, registry.definitions());
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.match(requests[1].messages.at(-1).content, /window-1/u);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AutoReplyService completes a multi-round ReAct loop", async () => {
  const registry = new ToolRegistry();
  for (const [name, value] of [["minecraft_observe", "observed"], ["minecraft_inventory", "inventory"]]) {
    registry.register({
      name,
      description: `Read ${name}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true, value }),
    });
  }
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const responses = [
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "observe-1", type: "function", function: { name: "minecraft_observe", arguments: "{}" } }] } }] },
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "inventory-1", type: "function", function: { name: "minecraft_inventory", arguments: "{}" } }] } }] },
      { choices: [{ message: { role: "assistant", content: "已读取实时状态和背包。", tool_calls: [] } }] },
    ];
    return { ok: true, status: 200, text: async () => JSON.stringify(responses[requests.length - 1]) };
  };
  try {
    const service = new AutoReplyService({ toolRegistry: registry });
    service.config = { ...DEFAULT_CONFIG, apiKey: "test-key", maxToolRounds: 3 };
    const reply = await service.generateReply("检查当前状态", { id: "window-1" });
    assert.equal(reply, "已读取实时状态和背包。");
    assert.equal(requests.length, 3);
    assert.deepEqual(service.status.lastSkills, ["minecraft_observe", "minecraft_inventory"]);
    assert.equal(requests[1].messages.at(-2).role, "assistant");
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.equal(requests[2].messages.at(-2).tool_calls[0].id, "inventory-1");
    assert.match(requests[2].messages.at(-1).content, /inventory/u);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
