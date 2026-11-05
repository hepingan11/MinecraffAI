export const TREE_SCHEMA = {
  type: "object",
  properties: {
    quantity: { type: "integer", minimum: 1, maximum: 256 },
    maxMinutes: { type: "number", exclusiveMinimum: 0, maximum: 15 },
    maxBlocks: { type: "integer", minimum: 1, maximum: 512 },
    returnWhenFull: { type: "boolean" },
  },
  additionalProperties: false,
};

export const TREE_DEFAULTS = Object.freeze({
  quantity: 16,
  maxMinutes: 10,
  maxBlocks: 128,
  returnWhenFull: false,
});

export const TREE_LOGS = Object.freeze([
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log",
  "minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
  "minecraft:mangrove_log", "minecraft:cherry_log", "minecraft:pale_oak_log",
  "minecraft:crimson_stem", "minecraft:warped_stem",
]);

export const TREE_LEAVES = Object.freeze([
  "minecraft:oak_leaves", "minecraft:spruce_leaves", "minecraft:birch_leaves",
  "minecraft:jungle_leaves", "minecraft:acacia_leaves", "minecraft:dark_oak_leaves",
  "minecraft:mangrove_leaves", "minecraft:cherry_leaves", "minecraft:pale_oak_leaves",
]);

export const TREE_DROPS = Object.freeze([
  ...TREE_LOGS,
  "minecraft:oak_sapling", "minecraft:spruce_sapling", "minecraft:birch_sapling",
  "minecraft:jungle_sapling", "minecraft:acacia_sapling", "minecraft:dark_oak_sapling",
  "minecraft:mangrove_propagule", "minecraft:cherry_sapling", "minecraft:pale_oak_sapling",
  "minecraft:stick", "minecraft:apple", "minecraft:cocoa_beans",
]);

