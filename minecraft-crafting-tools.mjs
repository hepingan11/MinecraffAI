import { getCraftingRecipes, craftItem } from "./minecraft-mod-api.mjs";
import { RECIPES_SCHEMA, CRAFT_SCHEMA } from "./minecraft-crafting-schema.mjs";
import { registerOperationTool } from "./minecraft-operation-tool.mjs";

export function registerCraftingTools(registry, options = {}) {
  registry.register({
    name: "minecraft_recipes", readOnly: true, parameters: RECIPES_SCHEMA,
    description: "查询当前服务器已解锁的普通合成配方，按产物 itemId 返回材料候选、每批产量、所需批次、工作台要求和当前材料是否足够。配方编号仅在当前服务器会话有效。空列表不表示游戏不存在该配方。",
    handler: (args, context) => getCraftingRecipes(context.window, args),
  });
  return registerOperationTool(registry, {
    name: "minecraft_craft", parameters: CRAFT_SCHEMA, kind: "craft", resultKey: "craft", run: craftItem,
    description: "按真实配方合成新增 quantity 个 itemId（1–64，按配方整批取整），等待背包结果。支持背包 2×2 和交互范围内可见工作台 3×3，自动打开可用工作台。先查询 minecraft_recipes；缺材料、未解锁、无工作台或空间不足则失败，不会自动采集、放置工作台、熔炼或合成前置材料。dimension 来自观察；失败后先检查部分产物和 recoveryRequired，禁止盲目重试。",
  }, options);
}
