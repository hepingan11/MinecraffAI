package com.minecraffai.mod;

import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.crafting.Ingredient;

/** Uses real vanilla registries and allocation, without a world or player. */
public final class CraftingMaterialsTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }

    public static void main(String[] args) {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        // 26.2 normally binds item defaults while loading world data. For this
        // world-free allocator test, plain wood only needs common item defaults.
        Items.OAK_PLANKS.builtInRegistryHolder().bindComponents(DataComponents.COMMON_ITEM_COMPONENTS);
        Items.BIRCH_PLANKS.builtInRegistryHolder().bindComponents(DataComponents.COMMON_ITEM_COMPONENTS);
        Ingredient wood = Ingredient.of(Items.OAK_PLANKS, Items.BIRCH_PLANKS);
        Ingredient oakOnly = Ingredient.of(Items.OAK_PLANKS);
        // Greedy per-slot counts can double-spend the only oak. Vanilla must allocate
        // birch to the flexible slot and preserve oak for the constrained slot.
        var mixed = List.of(new ItemStack(Items.OAK_PLANKS), new ItemStack(Items.BIRCH_PLANKS));
        check(CraftingMaterials.canCraft(mixed, List.of(wood, oakOnly), 1), "overlapping alternatives should allocate correctly");
        check(!CraftingMaterials.canCraft(List.of(new ItemStack(Items.OAK_PLANKS)), List.of(wood, oakOnly), 1), "one item cannot satisfy two slots");
        check(CraftingMaterials.canCraft(List.of(new ItemStack(Items.OAK_PLANKS, 4)), List.of(wood, wood), 2), "enough material for all batches");
        check(!CraftingMaterials.canCraft(List.of(new ItemStack(Items.OAK_PLANKS, 3)), List.of(wood, wood), 2), "must preflight all batches");
        check(CraftingMaterials.canCraft(List.of(new ItemStack(Items.OAK_PLANKS, 64), new ItemStack(Items.BIRCH_PLANKS, 64)), List.of(wood, wood), 64), "64 batches and split stacks");
        check(!CraftingMaterials.canCraft(List.of(ItemStack.EMPTY), List.of(wood), 1), "empty stacks are not ingredients");
        check(!CraftingMaterials.canCraft(mixed, List.of(), 1), "reject empty requirements");
        check(!CraftingMaterials.canCraft(mixed, List.of(wood), 65), "enforce batch budget");
        ItemStack named = new ItemStack(Items.OAK_PLANKS, 2);
        named.set(DataComponents.CUSTOM_NAME, Component.literal("keep this"));
        check(!CraftingMaterials.canCraft(List.of(named), List.of(wood, wood), 1), "vanilla excludes named inventory items from auto placement");
        System.out.println("CraftingMaterials: 9 native allocation checks passed");
    }
}
