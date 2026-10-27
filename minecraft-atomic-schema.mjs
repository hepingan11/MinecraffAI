// Shared by backend tool registration and direct Mod API wrappers.
const blockId = { type: "string", pattern: "^minecraft:[a-z0-9_./-]+$", maxLength: 128 };
const position = {
  x: { type: "integer", minimum: -30000000, maximum: 30000000 },
  y: { type: "integer", minimum: -64, maximum: 320 },
  z: { type: "integer", minimum: -30000000, maximum: 30000000 },
};
const dimension = { type: "string", pattern: "^[a-z0-9_.-]+:[a-z0-9_./-]+$", maxLength: 128 };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const SCAN_BLOCKS_SCHEMA = schema({
  ...position,
  blocks: { type: "array", minItems: 1, maxItems: 16, items: blockId },
  radius: { type: "integer", minimum: 1, maximum: 16 },
  maxResults: { type: "integer", minimum: 1, maximum: 64 },
});
export const BREAK_BLOCK_SCHEMA = schema({ ...position, dimension, expectedBlockId: blockId }, ["x", "y", "z", "dimension", "expectedBlockId"]);
export const PLACE_BLOCK_SCHEMA = schema({
  ...position, dimension, itemId: blockId,
  face: { type: "string", enum: ["up", "down", "north", "south", "east", "west"] },
}, ["x", "y", "z", "dimension", "itemId"]);
export const MOVE_TO_SCHEMA = schema({ ...position, dimension, distance: { type: "number", minimum: 0.5, maximum: 3 } }, ["x", "y", "z", "dimension"]);
