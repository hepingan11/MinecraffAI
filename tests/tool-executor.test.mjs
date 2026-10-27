import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../tool-registry.mjs";
import { ToolExecutor } from "../tool-executor.mjs";

test("ToolRegistry applies Numen-style backend schema validation and lenient lookup", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_state",
    description: "Read state",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["live", "cached"] } },
      required: ["mode"],
      additionalProperties: false,
    },
    handler: async (args) => ({ ok: true, mode: args.mode }),
  });
  assert.equal(registry.resolve("READ_STATE")?.name, "read_state");
  assert.deepEqual(await registry.invoke("READ_STATE", { mode: "live" }), { ok: true, mode: "live" });
  assert.match((await registry.invoke("read_state", {})).executionError, /必填/u);
  assert.match((await registry.invoke("read_state", { mode: "live", extra: true })).executionError, /不是允许/u);
});

test("ToolExecutor dispatches calls serially and settles structured results", async () => {
  const order = [];
  const registry = new ToolRegistry();
  for (const name of ["first", "second"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => { order.push(`${name}:start`); await new Promise((resolve) => setTimeout(resolve, 5)); order.push(`${name}:end`); return { ok: true, name }; },
    });
  }
  const events = [];
  const executor = new ToolExecutor({ registry, callTimeoutMs: 1000 });
  const results = await executor.run([
    { id: "1", function: { name: "first", arguments: "{}" } },
    { id: "2", function: { name: "second", arguments: "{}" } },
  ], {}, {
    started: ({ call }) => events.push(`start:${call.id}`),
    finished: ({ call }) => events.push(`finish:${call.id}`),
  });
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.deepEqual(events, ["start:1", "finish:1", "start:2", "finish:2"]);
  assert.deepEqual(results.map((item) => item.result), [{ ok: true, name: "first" }, { ok: true, name: "second" }]);
  assert.equal(executor.busy, false);
});

test("urgent cancellation settles the active and queued calls with backend-visible failures", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "long_action",
    description: "Long action",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, context) => new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ ok: true, late: true }), { once: true })),
  });
  const executor = new ToolExecutor({ registry, callTimeoutMs: 1000 });
  const running = executor.run([{ id: "active", function: { name: "long_action", arguments: "{}" } }, { id: "queued", function: { name: "long_action", arguments: "{}" } }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(executor.arrived({ type: "chat.message" }, true), true);
  const results = await running;
  assert.equal(results.length, 2);
  assert.equal(results[0].result.cancelled, true);
  assert.equal(results[1].result.cancelled, true);
  assert.equal(executor.busy, false);
});
