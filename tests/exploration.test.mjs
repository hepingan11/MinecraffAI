import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exploreForOre, registerExplorationTools, validateExplorationPlan } from "../src/skills/minecraft-exploration-tools.mjs";
import { TaskStateStore } from "../src/core/task-state.mjs";
import { ToolRegistry } from "../src/core/tool-registry.mjs";
import { EventQueue } from "../src/core/event-queue.mjs";

const dimension = "minecraft:overworld";
const iron = "minecraft:iron_ore";

function fakeGame({ hidden = false, targetAfterExplore = false, noTarget = false } = {}) {
  const calls = [];
  const position = { x: 0, y: 64, z: 0 };
  let rawIron = 0;
  let moved = false;
  let broken = false;
  let scanCount = 0;
  const target = { x: targetAfterExplore ? 9 : 10, y: 64, z: 0, blockId: iron };
  return {
    calls,
    api: {
      async getEnvironment() { calls.push("environment"); return { ok: true, dimension, position: { ...position } }; },
      async getInventory() { calls.push("inventory"); return { ok: true, items: rawIron ? [{ itemId: "minecraft:raw_iron", count: rawIron }] : [] }; },
      async scanBlocks(_window, args) {
        calls.push(`scan:${args.radius}`); scanCount += 1;
        if (noTarget) return { ok: true, dimension, blocks: [] };
        if (targetAfterExplore && !moved) return { ok: true, dimension, blocks: [] };
        if (targetAfterExplore && moved) return { ok: true, dimension, blocks: [{ ...target, visible: true, inReach: true, distance: 1 }] };
        if (scanCount === 1) return { ok: true, dimension, blocks: [] };
        return { ok: true, dimension, blocks: [{ ...target, visible: hidden ? (args.radius === 4 || moved) : true, inReach: moved, distance: moved ? 1 : 10 }] };
      },
      async moveTo(_window, args) {
        calls.push(`move:${args.x},${args.y},${args.z}`); moved = true;
        position.x = args.x; position.y = args.y; position.z = args.z;
        return { ok: true, move: { state: "completed", active: false } };
      },
      async breakBlock(_window, args) {
        calls.push("break");
        assert.equal(args.expectedBlockId, iron);
        broken = true; rawIron += 1;
        return { ok: true, action: { state: "completed", active: false, changed: true } };
      },
    },
    state: () => ({ rawIron, moved, broken }),
  };
}

test("后端校验寻矿计划，只允许可核验掉落的矿石", () => {
  assert.equal(validateExplorationPlan({ targetBlocks: [iron], quantity: 2 }).quantity, 2);
  assert.throws(() => validateExplorationPlan({ targetBlocks: ["minecraft:stone"] }), /掉落核验/u);
  assert.throws(() => validateExplorationPlan({ scanRadius: 3 }), /scanRadius/u);
});

test("可见矿石执行：分阶段扫描 -> 移动 -> 重扫 -> 破坏 -> 背包核验", async () => {
  const game = fakeGame();
  const result = await exploreForOre({ id: "window-1" }, { targetBlocks: [iron], quantity: 1, maxExplorationSteps: 2 }, { api: game.api });
  assert.equal(result.ok, true);
  assert.equal(result.collected, 1);
  assert.deepEqual(game.calls, ["inventory", "environment", "scan:8", "scan:16", "move:10,64,0", "environment", "scan:4", "break", "environment", "inventory"]);
  assert.equal(game.state().broken, true);
});

test("被遮挡矿石不会直接破坏，先寻找观察点并重新确认可见性", async () => {
  const game = fakeGame({ hidden: true });
  const result = await exploreForOre({ id: "window-1" }, { targetBlocks: [iron], quantity: 1, maxExplorationSteps: 2 }, { api: game.api });
  assert.equal(result.ok, true);
  assert.ok(game.calls.indexOf("break") > game.calls.indexOf("scan:4"));
  assert.equal(game.state().broken, true);
});

test("当前区域没有目标时步行到探索航点，再次扫描并完成数量评估", async () => {
  const game = fakeGame({ targetAfterExplore: true });
  const result = await exploreForOre({ id: "window-1" }, { targetBlocks: [iron], quantity: 1, maxExplorationSteps: 1 }, { api: game.api });
  assert.equal(result.ok, true);
  assert.equal(result.progress.explorationSteps, 1);
  assert.equal(result.collected, 1);
  assert.ok(game.calls.some((call) => call.startsWith("move:")));
});

test("寻矿任务写入统一任务状态并可区分目标未找到", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-explore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStateStore(path.join(dir, "tasks.json"));
  await store.load();
  const game = fakeGame({ noTarget: true });
  const result = await exploreForOre({ id: "window-1" }, { targetBlocks: [iron], quantity: 1, maxExplorationSteps: 1 }, { api: game.api, taskState: store });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, "target_not_found");
  assert.equal(store.get(result.taskId).status, "failed");
  assert.equal(store.get(result.taskId).progress.explorationSteps, 1);
});

test("寻矿工具注册到 ToolRegistry 并保持后端执行器边界", async () => {
  const registry = new ToolRegistry();
  const queue = new EventQueue();
  const game = fakeGame();
  registerExplorationTools(registry, { api: game.api, eventQueue: queue });
  assert.ok(registry.get("minecraft_explore_for_ore"));
  assert.equal(registry.get("minecraft_explore_for_ore").readOnly, false);
  const result = await registry.invoke("minecraft_explore_for_ore", { targetBlocks: [iron], quantity: 1 }, { window: { id: "window-1" } });
  assert.equal(result.ok, true);
  assert.ok(queue.recent(100).some((event) => event.type === "agent.task_progress" && event.data.kind === "ore_exploration"));
});


test("ore exploration opens a safe tunnel and walks to item drops before inventory verification", async () => {
  const calls = [];
  let moved = false;
  let dropCollected = false;
  let pathOpened = false;
  const api = {
    async getInventory() {
      calls.push("inventory");
      return { ok: true, items: dropCollected ? [{ itemId: "minecraft:raw_iron", count: 1 }] : [] };
    },
    async getEnvironment() {
      calls.push("environment");
      return {
        ok: true,
        dimension,
        position: { x: moved ? 4 : 0, y: 64, z: 0 },
        nearbyEntities: dropCollected ? [] : [{ type: "minecraft:item", itemId: "minecraft:raw_iron", count: 1, x: 4, y: 64, z: 0, distance: 4 }],
      };
    },
    async scanBlocks(_window, args) {
      calls.push(args.blocks ? "target-scan" : "path-scan");
      if (!args.blocks) return { ok: true, dimension, blocks: pathOpened ? [] : [{ x: 1, y: 64, z: 0, dimension, blockId: "minecraft:stone", visible: true, inReach: true, distance: 1 }] };
      return { ok: true, dimension, blocks: [{ x: 4, y: 64, z: 0, blockId: iron, visible: moved, inReach: moved, distance: moved ? 1 : 4 }] };
    },
    async moveTo(_window, args) {
      calls.push("move:" + args.x);
      if (!pathOpened && args.x === 3) return { ok: false, move: { state: "stuck" }, executionError: "blocked" };
      moved = true;
      if (args.x === 4) dropCollected = true;
      return { ok: true, move: { state: "completed" } };
    },
    async breakBlock(_window, args) {
      calls.push("break:" + args.expectedBlockId);
      if (args.expectedBlockId === "minecraft:stone") pathOpened = true;
      return { ok: true, action: { state: "completed", changed: true } };
    },
  };
  const result = await exploreForOre({ id: "window-1" }, { targetBlocks: [iron], quantity: 1, maxExplorationSteps: 1 }, { api });
  assert.equal(result.ok, true);
  assert.equal(result.collected, 1);
  assert.equal(result.progress.pathBlocksBroken, 1);
  assert.ok(calls.includes("break:minecraft:stone"));
  assert.ok(calls.includes("break:minecraft:iron_ore"));
  assert.ok(calls.filter((item) => item === "move:4").length >= 1);
});
