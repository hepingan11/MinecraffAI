import test from "node:test";
import assert from "node:assert/strict";
import { CommandRuntime, parseCommandEnvelope } from "../src/core/command-runtime.mjs";
import { ToolExecutor } from "../src/core/tool-executor.mjs";
import { ToolRegistry } from "../src/core/tool-registry.mjs";
import { AutoReplyService, DEFAULT_CONFIG } from "../src/core/auto-reply.mjs";

function registryForTests() {
  const registry = new ToolRegistry();
  let observed = 0;
  registry.register({
    name: "minecraft_observe",
    description: "observe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true, state: "idle", count: ++observed }),
  });
  registry.register({
    name: "minecraft_move_to",
    description: "move",
    parameters: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
      required: ["x", "y", "z"],
      additionalProperties: false,
    },
    handler: async (args) => ({ ok: true, position: args }),
  });
  return registry;
}

test("命令流解析只接受白名单操作和结构化 JSON", () => {
  const registry = registryForTests();
  const parsed = parseCommandEnvelope(`
    \`\`\`json
    {"commands":[{"op":"observe"},{"op":"move_to","args":{"x":1,"y":64,"z":-2}}],"reply":""}
    \`\`\`
  `, { registry });
  assert.deepEqual(parsed.commands.map((command) => command.op), ["observe", "move_to"]);
  assert.deepEqual(parsed.commands[1].arguments, { x: 1, y: 64, z: -2 });
  assert.throws(() => parseCommandEnvelope('{"commands":[{"op":"run_shell","args":{"command":"dir"}}]}', { registry }), /不支持/u);
  assert.throws(() => parseCommandEnvelope('{"commands":[{"op":"move_to","args":{"x":1}}]}', { registry }), /必填/u);
});

test("CommandRuntime 按顺序执行命令并复用后端 schema 校验", async () => {
  const registry = registryForTests();
  const executor = new ToolExecutor({ registry, callTimeoutMs: 1000 });
  const runtime = new CommandRuntime({ registry, executor });
  const order = [];
  const result = await runtime.run([
    { id: "observe-1", op: "observe", args: {} },
    { id: "move-1", op: "move_to", args: { x: 1, y: 64, z: -2 } },
  ], { window: { id: "window-1" } }, {
    started: ({ call }) => order.push(`start:${call.command.op}`),
    finished: ({ call }) => order.push(`finish:${call.command.op}`),
  });
  assert.deepEqual(order, ["start:observe", "finish:observe", "start:move_to", "finish:move_to"]);
  assert.equal(result[1].result.position.z, -2);
  await assert.rejects(() => runtime.run([{ op: "move_to", args: { x: 1 } }]), /必填/u);
});

test("命令流支持变量引用、条件分支和有上限的循环", async () => {
  const registry = registryForTests();
  const runtime = new CommandRuntime({ registry, executor: new ToolExecutor({ registry, callTimeoutMs: 1000 }), maxSteps: 32 });
  const records = await runtime.run([
    { op: "set", name: "x", value: 1 },
    { op: "set", name: "y", value: 64 },
    { op: "set", name: "z", value: -2 },
    { op: "move_to", args: { x: "$vars.x", y: "$vars.y", z: "$vars.z" } },
    { op: "if", condition: { path: "last.result.ok", equals: true }, then: [{ op: "observe" }], else: [{ op: "set", name: "fallback", value: true }] },
    { op: "repeat_until", condition: { path: "last.result.count", gte: 3 }, maxIterations: 4, steps: [{ op: "observe" }] },
  ]);
  const move = records.find((item) => item.command.op === "move_to");
  assert.deepEqual(move.command.arguments, { x: 1, y: 64, z: -2 });
  const loop = records.find((item) => item.command.op === "repeat_until");
  assert.equal(loop.result.ok, true);
  assert.equal(loop.result.iterations, 2);
  const whileRegistry = registryForTests();
  const whileRuntime = new CommandRuntime({ registry: whileRegistry, executor: new ToolExecutor({ registry: whileRegistry, callTimeoutMs: 1000 }), maxSteps: 16 });
  const whileRecords = await whileRuntime.run([
    { op: "observe" },
    { op: "repeat_while", condition: { path: "last.result.count", lt: 3 }, maxIterations: 4, steps: [{ op: "observe" }] },
  ]);
  const whileLoop = whileRecords.find((item) => item.command.op === "repeat_while");
  assert.equal(whileLoop.result.ok, true);
  await assert.rejects(() => runtime.run([{ op: "move_to", args: { x: "$vars.missing", y: 64, z: 0 } }]), /状态引用不存在/u);
});

test("AutoReplyService 命令流模式不向模型暴露 tools，并把结果反馈到下一轮", async () => {
  const registry = registryForTests();
  const service = new AutoReplyService({ toolRegistry: registry });
  service.config = { ...DEFAULT_CONFIG, enabled: true, apiKey: "test-key", executionMode: "commands", maxCommandRounds: 4 };
  const requests = [];
  const bodies = [
    { choices: [{ message: { role: "assistant", content: '{"commands":[{"op":"observe","args":{}}],"reply":""}' } }] },
    { choices: [{ message: { role: "assistant", content: '{"commands":[],"reply":"已读取当前状态。"}' } }] },
  ];
  service.requestModel = async (state, tools) => {
    requests.push({ messages: state.messages.map((message) => ({ ...message })), tools });
    return bodies.shift();
  };
  const reply = await service.generateReply("现在状态如何？", { id: "window-1" });
  assert.equal(reply, "已读取当前状态。");
  assert.deepEqual(requests.map((request) => request.tools), [[], []]);
  assert.match(requests[1].messages.at(-1).content, /command_results/u);
});
