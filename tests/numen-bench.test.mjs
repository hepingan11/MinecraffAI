import test from "node:test";
import assert from "node:assert/strict";
import { loadAllNumenBenchScenarios, loadNumenBenchIndex } from "../src/bench/numen-bench.mjs";

test("Numen Bench 迁移数据可以被后端完整加载", async () => {
  const index = await loadNumenBenchIndex();
  const scenarios = await loadAllNumenBenchScenarios();
  assert.equal(scenarios.length, 6);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    index.scenarios.map((entry) => entry.id),
  );
  for (const scenario of scenarios) {
    assert.equal(scenario.source.project, "minecraft-numen");
    assert.equal(scenario.source.gameVersion, "1.21.1");
    assert.equal(scenario.targetGameVersion, "26.2");
    assert.ok(scenario.goals.success.length >= 1);
    assert.ok(scenario.referencePlan.length >= 1);
  }
});

test("场景只保存抽象行为，不携带 Numen Lua 运行时调用", async () => {
  const scenarios = await loadAllNumenBenchScenarios();
  const serialized = JSON.stringify(scenarios);
  assert.doesNotMatch(serialized, /numen\.(?:work|move|inv|build|scan)\./u);
});

test("关键场景的目标和初始工具数据已迁移", async () => {
  const scenarios = Object.fromEntries((await loadAllNumenBenchScenarios()).map((scenario) => [scenario.id, scenario]));
  assert.equal(scenarios.mine_iron_hidden_cluster.goals.success[0].itemId, "minecraft:raw_iron");
  assert.equal(scenarios.dig_deep_diamond.initialState.inventory[0].itemId, "minecraft:iron_pickaxe");
  assert.equal(scenarios.iron_pickaxe_chain.budget.turns, 60);
  assert.equal(scenarios.craft_stone_pickaxe.initialState.inventory[0].count, 3);
  assert.equal(scenarios.chest_in_wall.initialState.world.blocks.find((block) => block.blockId === "minecraft:chest").contents[0].count, 5);
  assert.equal(scenarios.build_wall_between_posts.goals.success[0].minimum, 0.9);
});
