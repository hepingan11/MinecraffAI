import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nbt from "prismarine-nbt";
import { listLitematicNames, readLitematic } from "../src/skills/litematic-blueprint.mjs";
import { BUILD_SCHEMA } from "../src/skills/minecraft-build-tools.mjs";
import { validateSchema } from "../src/core/tool-registry.mjs";

function paletteEntry(name, properties = {}) {
  return { Name: nbt.string(name), Properties: nbt.comp(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, nbt.string(value)]))) };
}

test("reads compressed Litematica regions, palette indices, materials and rotation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraffai-blueprint-"));
  try {
    // 2 x 1 x 2, indices in x + z * width order: stone, air, oak, stone.
    // bitsPerBlock=2, packed low bits are 1, 0, 2, 1.
    const packed = 1n | (2n << 4n) | (1n << 6n);
    const root = nbt.comp({
      Version: nbt.int(6),
      Metadata: nbt.comp({ EnclosingSize: nbt.comp({ x: nbt.int(2), y: nbt.int(1), z: nbt.int(2) }) }),
      Regions: nbt.comp({ house: nbt.comp({
        Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }),
        Size: nbt.comp({ x: nbt.int(2), y: nbt.int(1), z: nbt.int(2) }),
        BlockStatePalette: nbt.list(nbt.comp([paletteEntry("minecraft:air"), paletteEntry("minecraft:stone"), paletteEntry("minecraft:oak_planks", { axis: "y" })])),
        BlockStates: nbt.longArray([packed]),
      }) }),
    });
    await writeFile(path.join(directory, "test.litematic"), nbt.writeUncompressed(root));
    await writeFile(path.join(directory, "甜品摊.litematic"), nbt.writeUncompressed(root));
    const result = await readLitematic("test", { directory, origin: { x: 10, y: 64, z: 20 }, rotation: 90 });
    assert.equal(result.blockCount, 3);
    assert.deepEqual(result.materials, { "minecraft:oak_planks": 1, "minecraft:stone": 2 });
    assert.deepEqual(result.targets.map(({ x, y, z, blockId }) => ({ x, y, z, blockId })), [
      { x: 10, y: 64, z: 20, blockId: "minecraft:stone" },
      { x: 9, y: 64, z: 20, blockId: "minecraft:oak_planks" },
      { x: 9, y: 64, z: 21, blockId: "minecraft:stone" },
    ]);
    assert.equal(result.targets[1].blockState, "minecraft:oak_planks[axis=y]");
    const chinese = await readLitematic("甜品摊", { directory });
    assert.equal(chinese.name, "甜品摊.litematic");
    assert.equal(chinese.blockCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects blueprint path traversal and oversized target plans", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraffai-blueprint-"));
  try {
    await assert.rejects(() => readLitematic("../secret", { directory }), /蓝图名称只能包含/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts Chinese blueprint names in the backend tool schema", () => {
  assert.doesNotThrow(() => validateSchema({
    name: "甜品摊.litematic",
    origin: { x: 0, y: 64, z: 0 },
    dimension: "minecraft:overworld",
  }, BUILD_SCHEMA));
});

test("searches configured blueprint directories and lists actual files", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "minecraffai-blueprint-a-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "minecraffai-blueprint-b-"));
  const previous = process.env.MC_AI_BLUEPRINT_DIRS;
  try {
    await writeFile(path.join(second, "甜品摊.litematic"), "placeholder");
    process.env.MC_AI_BLUEPRINT_DIRS = [first, second].join(path.delimiter);
    const result = await listLitematicNames();
    assert.deepEqual(result.directories, [first, second].map((item) => path.resolve(item)));
    assert.deepEqual(result.files, ["甜品摊.litematic"]);
  } finally {
    if (previous === undefined) delete process.env.MC_AI_BLUEPRINT_DIRS;
    else process.env.MC_AI_BLUEPRINT_DIRS = previous;
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
