import test from "node:test";
import assert from "node:assert/strict";
import { chopTrees, registerTreeTools, validateTreePlan } from "../src/skills/minecraft-tree-tools.mjs";
import { ToolRegistry } from "../src/core/tool-registry.mjs";
import { EventQueue } from "../src/core/event-queue.mjs";

const dimension = "minecraft:overworld";

test("tree plans are backend validated", () => {
  assert.equal(validateTreePlan({ quantity: 4 }).quantity, 4);
  assert.throws(() => validateTreePlan({ quantity: 0 }), /quantity/u);
  assert.throws(() => validateTreePlan({ maxMinutes: 16 }), /maxMinutes/u);
});

test("tree chopping scans 64 blocks, cuts logs, walks to drops and verifies inventory", async () => {
  const calls = [];
  let position = { x: 0, y: 64, z: 0 };
  let broken = 0;
  let dropsAvailable = true;
  const logs = [
    { x: 40, y: 64, z: 0, dimension, blockId: "minecraft:oak_log", visible: false, inReach: false, distance: 40 },
    { x: 40, y: 65, z: 0, dimension, blockId: "minecraft:oak_log", visible: false, inReach: false, distance: 40 },
  ];
  const api = {
    async getInventory() {
      calls.push("inventory");
      return { ok: true, items: broken ? [{ itemId: "minecraft:oak_log", count: broken }] : [] };
    },
    async getEnvironment() {
      calls.push("environment");
      return {
        ok: true, dimension, position: { ...position },
        nearbyEntities: dropsAvailable ? [{ type: "minecraft:item", itemId: "minecraft:oak_log", count: 1, x: 40, y: 64, z: 0, distance: 2 }] : [],
      };
    },
    async scanBlocks(_window, args) {
      calls.push({ type: "scan", radius: args.radius, verticalRadius: args.verticalRadius, blocks: args.blocks });
      if (args.radius === 64) return { ok: true, dimension, blocks: logs };
      return { ok: true, dimension, blocks: logs.map((block) => ({ ...block, visible: true, inReach: true, distance: 1 })) };
    },
    async moveTo(_window, args) {
      calls.push({ type: "move", x: args.x, y: args.y, z: args.z });
      position = { x: args.x, y: args.y, z: args.z };
      if (args.x === 40) dropsAvailable = false;
      return { ok: true, move: { state: "completed", active: false } };
    },
    async breakBlock(_window, args) {
      calls.push({ type: "break", expectedBlockId: args.expectedBlockId });
      assert.equal(args.expectedBlockId, "minecraft:oak_log");
      broken += 1;
      dropsAvailable = true;
      return { ok: true, action: { state: "completed", active: false, changed: true } };
    },
  };
  const result = await chopTrees({ id: "window-1" }, { quantity: 2 }, { api });
  assert.equal(result.ok, true);
  assert.equal(result.collected, 2);
  assert.equal(result.blocksBroken, 2);
  assert.ok(calls.some((call) => call.type === "scan" && call.radius === 64 && call.verticalRadius === 32));
  assert.equal(calls.filter((call) => call.type === "break").length, 2);
  assert.ok(calls.filter((call) => call.type === "move" && call.x === 40).length >= 2);
});

test("tree tool is registered as a backend task and publishes progress", async () => {
  const registry = new ToolRegistry();
  const queue = new EventQueue();
  const api = {
    async getInventory() { return { ok: true, items: [{ itemId: "minecraft:oak_log", count: 1 }] }; },
    async getEnvironment() { return { ok: true, dimension, position: { x: 0, y: 64, z: 0 }, nearbyEntities: [] }; },
    async scanBlocks() { return { ok: true, dimension, blocks: [] }; },
  };
  registerTreeTools(registry, { api, eventQueue: queue });
  assert.ok(registry.get("minecraft_chop_tree"));
  const result = await registry.invoke("minecraft_chop_tree", { quantity: 1 }, { window: { id: "window-1" } });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, "target_not_found");
  assert.ok(queue.recent(20).some((event) => event.type === "agent.task_progress" && event.data.kind === "tree_chopping"));
});

