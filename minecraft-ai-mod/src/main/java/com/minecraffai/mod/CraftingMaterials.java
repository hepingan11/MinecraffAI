package com.minecraffai.mod;

import net.minecraft.world.entity.player.StackedItemContents;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;
import java.util.ArrayList;
import java.util.List;

/** Exact vanilla allocation, including overlapping alternatives across recipe slots. */
public final class CraftingMaterials {
    private CraftingMaterials() {}

    public static boolean canCraft(List<ItemStack> inventory, List<Ingredient> ingredients, int batches) {
        if (batches < 1 || batches > 64 || ingredients.isEmpty() || ingredients.size() > 9) return false;
        List<Ingredient> needed = new ArrayList<>();
        for (int batch = 0; batch < batches; batch++) needed.addAll(ingredients);
        StackedItemContents contents = new StackedItemContents();
        for (ItemStack stack : inventory) contents.accountSimpleStack(stack);
        return contents.canCraft(needed, null);
    }
}
