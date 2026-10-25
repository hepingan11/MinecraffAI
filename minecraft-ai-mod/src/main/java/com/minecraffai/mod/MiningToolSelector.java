package com.minecraffai.mod;

import java.util.Comparator;
import java.util.List;

/** Shared selection rules for snapshots and live inventory. Never rank tools by display name. */
public final class MiningToolSelector {
    public static final List<String> PRIORITY = List.of(
        "minecraft:netherite_pickaxe", "minecraft:diamond_pickaxe", "minecraft:iron_pickaxe",
        "minecraft:golden_pickaxe", "minecraft:stone_pickaxe", "minecraft:wooden_pickaxe");

    public record Tool(int slot, String itemId, boolean broken, boolean suitable) {}

    public static Tool choose(List<Tool> tools, int selectedSlot) {
        return tools.stream().filter(tool -> ((tool.slot >= 0 && tool.slot < 36) || tool.slot == 40)
            && PRIORITY.contains(tool.itemId) && !tool.broken && tool.suitable)
            .min(Comparator.comparingInt((Tool tool) -> PRIORITY.indexOf(tool.itemId))
                .thenComparingInt(tool -> tool.slot == selectedSlot ? 0 : 1)
                .thenComparingInt(tool -> tool.slot < 9 ? 0 : 1)
                .thenComparingInt(Tool::slot))
            .orElse(null);
    }
}
