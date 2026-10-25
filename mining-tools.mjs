export const PICKAXE_PRIORITY = Object.freeze([
  "minecraft:netherite_pickaxe",
  "minecraft:diamond_pickaxe",
  "minecraft:iron_pickaxe",
  "minecraft:golden_pickaxe",
  "minecraft:stone_pickaxe",
  "minecraft:wooden_pickaxe",
]);

export function recognizeMiningPickaxes(inventory) {
  if (inventory?.ok !== true || !Array.isArray(inventory.items)) throw new Error("无法识别背包工具：Mod 返回的背包数据无效");
  return inventory.items.filter((item) => item && Number.isInteger(item.slot)
    && ((item.slot >= 0 && item.slot < 36) || item.slot === 40)
    && PICKAXE_PRIORITY.includes(item.itemId) && Number.isInteger(item.count) && item.count > 0
    && item.broken !== true && !(item.maxDamage > 0 && item.damage >= item.maxDamage))
    .sort((a, b) => PICKAXE_PRIORITY.indexOf(a.itemId) - PICKAXE_PRIORITY.indexOf(b.itemId)
      || Number(b.slot === inventory.selectedSlot) - Number(a.slot === inventory.selectedSlot)
      || Number(b.slot < 9) - Number(a.slot < 9) || a.slot - b.slot);
}
