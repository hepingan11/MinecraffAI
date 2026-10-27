const itemId = { type: "string", pattern: "^[a-z0-9_.-]+:[a-z0-9_./-]+$", maxLength: 128 };
const quantity = { type: "integer", minimum: 1, maximum: 64, description: "本次新增产物数量；按配方整批合成，可能略多于请求数量。默认 1。" };
export const RECIPES_SCHEMA = {
  type: "object", properties: { itemId, quantity, maxResults: { type: "integer", minimum: 1, maximum: 32 } },
  required: ["itemId"], additionalProperties: false,
};
export const CRAFT_SCHEMA = {
  type: "object", properties: {
    itemId, quantity, dimension: itemId,
    recipeId: { type: "integer", minimum: 0, maximum: 2147483647, description: "可选，来自当前服务器 minecraft_recipes 返回的配方编号。重新连接后需重新查询。" },
  }, required: ["itemId", "dimension"], additionalProperties: false,
};
