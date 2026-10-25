import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { PICKAXE_PRIORITY, recognizeMiningPickaxes } from "../mining-tools.mjs";
import { startMining } from "../minecraft-mod-api.mjs";

const item = (itemId, slot, fields = {}) => ({ itemId, slot, name: itemId, count: 1, damage: 0, maxDamage: 100, broken: false, ...fields });
const snapshot = (items) => ({ ok: true, selectedSlot: 0, miningToolSelection: "pickaxe_priority_v1", items });

test("all pickaxe combinations use the requested material priority, including gold before stone", () => {
  for (let mask = 1; mask < 64; mask++) {
    const entries = PICKAXE_PRIORITY.map((id, index) => item(id, index)).filter((_, index) => mask & (1 << index)).reverse();
    const expected = PICKAXE_PRIORITY.find((id) => entries.some((entry) => entry.itemId === id));
    assert.equal(recognizeMiningPickaxes(snapshot(entries))[0].itemId, expected);
  }
  assert.equal(recognizeMiningPickaxes(snapshot([item("minecraft:stone_pickaxe", 0), item("minecraft:golden_pickaxe", 16)]))[0].slot, 16);
});

test("scan includes main inventory/offhand, rejects broken/invalid tools and ignores display-name tricks", () => {
  const entries = [
    item("minecraft:iron_pickaxe", 0), item("minecraft:netherite_pickaxe", 24), item("minecraft:diamond_pickaxe", 40),
    item("minecraft:netherite_pickaxe", 8, { broken: true }), item("minecraft:netherite_pickaxe", 3, { damage: 100 }),
    item("minecraft:netherite_pickaxe", 36), item("minecraft:diamond_pickaxe", -1), item("minecraft:diamond_pickaxe", 999),
    item("minecraft:diamond_axe", 1, { name: "Netherite Pickaxe" }), item("minecraft:wooden_pickaxe", 2, { count: 0 }),
  ];
  assert.deepEqual(recognizeMiningPickaxes(snapshot(entries)).map((entry) => entry.slot), [24, 40, 0]);
  assert.throws(() => recognizeMiningPickaxes({ ok: true }), /无效/u);
});

test("equal-material ties preserve the selected tool, then prefer the hotbar", () => {
  const entries = [item("minecraft:diamond_pickaxe", 15), item("minecraft:diamond_pickaxe", 5), item("minecraft:diamond_pickaxe", 3)];
  assert.equal(recognizeMiningPickaxes({ ...snapshot(entries), selectedSlot: 5 })[0].slot, 5);
  assert.equal(recognizeMiningPickaxes(snapshot(entries))[0].slot, 3);
});

test("start must read/recognize inventory first and never sends a start after a failed preflight", async (t) => {
  const calls = [];
  let inventory = snapshot([item("minecraft:iron_pickaxe", 0), item("minecraft:diamond_pickaxe", 17)]);
  let startError = false;
  let inventoryError = false;
  const mod = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-mining-token");
    calls.push(req.url);
    let value = inventory;
    if (req.url === "/inventory" && inventoryError) { res.statusCode = 409; value = { ok: false, error: "尚未进入世界" }; }
    if (req.url === "/mining/start") {
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.equal(JSON.parse(body).quantity, 1);
      value = { ok: true, status: "equipping", mining: { selectedTool: item("minecraft:diamond_pickaxe", 1) } };
      if (startError) { res.statusCode = 409; value = { ok: false, error: "背包已变化，镐子已不可用" }; }
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  mod.listen(0, "127.0.0.1");
  await once(mod, "listening");
  t.after(() => new Promise((resolve) => mod.close(resolve)));
  const window = { host: "127.0.0.1", port: mod.address().port, token: "test-mining-token" };
  const result = await startMining(window, {});
  assert.deepEqual(calls.splice(0), ["/inventory", "/mining/start"]);
  assert.equal(result.toolRecognition.preferred.slot, 17);
  assert.equal(result.mining.selectedTool.itemId, "minecraft:diamond_pickaxe");
  assert.equal(result.inventory.items.length, 2);

  inventory = snapshot([item("minecraft:diamond_axe", 0)]);
  await assert.rejects(startMining(window, {}), /没有可用的镐/u);
  assert.deepEqual(calls.splice(0), ["/inventory"]);
  inventory = { ...snapshot([item("minecraft:diamond_pickaxe", 0)]), miningToolSelection: undefined };
  await assert.rejects(startMining(window, {}), /更新 Mod/u);
  assert.deepEqual(calls.splice(0), ["/inventory"]);
  await assert.rejects(startMining(window, { quantity: 0 }), /quantity/u);
  assert.deepEqual(calls, []);
  inventoryError = true;
  await assert.rejects(startMining(window, {}), /尚未进入世界/u);
  assert.deepEqual(calls.splice(0), ["/inventory"]);
  inventoryError = false;
  inventory = snapshot([item("minecraft:diamond_pickaxe", 17)]);
  startError = true;
  await assert.rejects(startMining(window, {}), /背包已变化/u);
  assert.deepEqual(calls, ["/inventory", "/mining/start"]);
});
