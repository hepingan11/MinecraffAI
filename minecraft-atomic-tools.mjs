import { scanBlocks, moveTo, breakBlock, placeBlock } from "./minecraft-mod-api.mjs";
import { SCAN_BLOCKS_SCHEMA, MOVE_TO_SCHEMA, BREAK_BLOCK_SCHEMA, PLACE_BLOCK_SCHEMA } from "./minecraft-atomic-schema.mjs";
import { registerOperationTool } from "./minecraft-operation-tool.mjs";

/** Production registration is reused by integration tests. No model-generated code runs here. */
export function registerAtomicTools(registry, { taskState = null } = {}) {
  registry.register({
    name: "minecraft_scan_blocks", readOnly: true,
    description: "扫描已加载区块，返回真实方块坐标、维度、可见性和交互距离。radius 1–16，maxResults 1–64。扫描能发现遮挡的方块，不代表存在通路。",
    parameters: SCAN_BLOCKS_SCHEMA,
    handler: (args, context) => scanBlocks(context.window, args),
  });
  for (const [name, parameters, run, description] of [
    ["minecraft_move_to", MOVE_TO_SCHEMA, moveTo, "安全步行到指定坐标附近并等待结束。最多 32 格、60 秒；不挖掘、不放置，无路返回失败。dimension 来自观察或扫描。"],
    ["minecraft_break_block", BREAK_BLOCK_SCHEMA, breakBlock, "按正常玩家挖掘速度破坏一个可见方块，自动选择兼容工具并等待读回结果。必须提供扫描得到的 dimension 和 expectedBlockId；超出交互距离需先移动。禁止挖脚下。"],
    ["minecraft_place_block", PLACE_BLOCK_SCHEMA, placeBlock, "用背包中的 itemId 放置一个方块并等待读回结果。x/y/z 是放置后的目标格，face 是相邻支撑面的朝向，默认 up。需要无遮挡支撑面和正确 dimension。"],
  ]) {
    registerOperationTool(registry, { name, description, parameters, run,
      kind: name === "minecraft_move_to" ? "move" : "block_action", resultKey: name === "minecraft_move_to" ? "move" : "action" }, { taskState });
  }
  return registry;
}
