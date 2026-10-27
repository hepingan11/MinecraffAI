const blockId = { type: "string", pattern: "^minecraft:[a-z0-9_./-]+$", maxLength: 128 };

export const EXPLORATION_SCHEMA = {
  type: "object",
  properties: {
    targetBlocks: { type: "array", minItems: 1, maxItems: 16, items: blockId },
    quantity: { type: "integer", minimum: 1, maximum: 256 },
    maxMinutes: { type: "number", exclusiveMinimum: 0, maximum: 30 },
    maxBlocks: { type: "integer", minimum: 1, maximum: 512 },
    maxExplorationSteps: { type: "integer", minimum: 1, maximum: 32 },
    scanRadius: { type: "integer", minimum: 4, maximum: 16 },
    returnWhenFull: { type: "boolean" },
  },
  additionalProperties: false,
};
