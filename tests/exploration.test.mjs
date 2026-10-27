import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exploreForOre, registerExplorationTools, validateExplorationPlan } from "../minecraft-exploration-tools.mjs";
import { TaskStateStore } from "../task-state.mjs";
import { ToolRegistry } from "../tool-registry.mjs";

const dimension = "minecraft:overworld";
const iron = "minecraft:iron_ore";

function fakeGame({ hidden = false, targetAfterExplore = false } = {}) {
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
        if (targetAfterExplore && !moved) return { ok: true, dimension, blocks: [] };
        if (targetAfterExplore && moved) return { ok: true, dimension, blocks: [{ ...target, visible: true, inReach: true, distance: 1 }] };
        if (scanCount === 1) return { ok: true, dimension, blocks: [] };
        return { ok: true, dimension, blocks: [{ ...target, visible: hidden ? !moved : true, inReach: moved, distance: moved ? 1 : 10 }] };
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
  assert.deepEqual(game.calls, ["inventory", "environment", "scan:8", "scan:16", "move:10,64,0", "environment", "scan:4", "break", "inventory"]);
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
  const game = fakeGame({ targetAfterExplore: false });
  const result = await exploreForOre({ id: "window-1" }, { targetBlocks: [iron], quantity: 1, maxExplorationSteps: 1 }, { api: game.api, taskState: store });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, "target_not_found");
  assert.equal(store.get(result.taskId).status, "failed");
  assert.equal(store.get(result.taskId).progress.explorationSteps, 1);
});

test("寻矿工具注册到 ToolRegistry 并保持后端执行器边界", () => {
  const registry = new ToolRegistry();
  registerExplorationTools(registry);
  assert.ok(registry.get("minecraft_explore_for_ore"));
  assert.equal(registry.get("minecraft_explore_for_ore").readOnly, false);
});
