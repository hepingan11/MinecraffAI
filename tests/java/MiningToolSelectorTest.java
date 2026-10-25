package com.minecraffai.mod;

import java.util.ArrayList;
import java.util.List;

public final class MiningToolSelectorTest {
    private static MiningToolSelector.Tool tool(int slot, String id) { return new MiningToolSelector.Tool(slot, id, false, true); }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }

    public static void main(String[] args) {
        for (int mask = 1; mask < 64; mask++) {
            var tools = new ArrayList<MiningToolSelector.Tool>();
            String expected = null;
            for (int index = 5; index >= 0; index--) {
                if ((mask & (1 << index)) != 0) {
                    expected = MiningToolSelector.PRIORITY.get(index);
                    tools.add(tool(index + 9, expected));
                }
            }
            check(MiningToolSelector.choose(tools, 0).itemId().equals(expected), "wrong priority for mask " + mask);
        }
        check(MiningToolSelector.choose(List.of(tool(0, "minecraft:stone_pickaxe"), tool(35, "minecraft:golden_pickaxe")), 0).slot() == 35, "gold must precede stone");
        check(MiningToolSelector.choose(List.of(tool(0, "minecraft:iron_pickaxe"), tool(40, "minecraft:diamond_pickaxe")), 0).slot() == 40, "offhand ignored");
        check(MiningToolSelector.choose(List.of(tool(0, "minecraft:diamond_axe")), 0) == null, "non-pickaxe accepted");
        check(MiningToolSelector.choose(List.of(tool(36, "minecraft:netherite_pickaxe"), tool(999, "minecraft:netherite_pickaxe")), 0) == null, "invalid slots accepted");
        check(MiningToolSelector.choose(List.of(new MiningToolSelector.Tool(0, "minecraft:netherite_pickaxe", true, true), tool(1, "minecraft:iron_pickaxe")), 0).slot() == 1, "broken tool selected");
        check(MiningToolSelector.choose(List.of(new MiningToolSelector.Tool(0, "minecraft:golden_pickaxe", false, false), tool(1, "minecraft:stone_pickaxe")), 0).slot() == 1, "incorrect harvest tool selected");
        check(MiningToolSelector.choose(List.of(tool(20, "minecraft:diamond_pickaxe"), tool(3, "minecraft:diamond_pickaxe"), tool(7, "minecraft:diamond_pickaxe")), 7).slot() == 7, "selected tool tie not preserved");
        check(MiningToolSelector.choose(List.of(tool(20, "minecraft:diamond_pickaxe"), tool(3, "minecraft:diamond_pickaxe")), 0).slot() == 3, "hotbar tie not preferred");
        check(MiningToolSelector.choose(List.of(), 0) == null, "empty inventory accepted");
        System.out.println("63 inventory combinations and 9 mining tool edge cases passed");
    }
}
