package com.minecraffai.mod;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.gui.screens.inventory.CraftingScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.AbstractCraftingMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.display.*;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Client-side execution of server-supplied recipes through ordinary player packets.
 * Never creates items or mutates inventory stacks directly. Called on the game thread. */
public final class CraftingController {
    private final Minecraft client;
    private final ScheduledExecutorService executor;
    private ScheduledFuture<?> ticker;
    private Task task;

    public CraftingController(Minecraft client, ScheduledExecutorService executor) {
        this.client = client; this.executor = executor;
    }

    public boolean isActive() { return task != null && task.active; }
    public void shutdown() { if (ticker != null) ticker.cancel(false); }

    private void world() {
        if (client.player == null || client.level == null || client.gameMode == null) throw new IllegalStateException("Minecraft 尚未进入世界");
    }

    private void safe() {
        world();
        if (!client.player.isAlive() || client.player.isSpectator() || client.player.getHealth() <= 6
            || client.player.getFoodData().getFoodLevel() <= 6 || client.player.isInLava()) throw new IllegalStateException("玩家状态不适合合成");
        if (client.isPaused()) throw new IllegalStateException("游戏已暂停");
        if (!client.player.containerMenu.getCarried().isEmpty()) throw new IllegalStateException("鼠标正在携带物品，请先放回背包");
        var screen = client.gui.screen();
        if (screen != null && !(screen instanceof InventoryScreen) && !(screen instanceof CraftingScreen)) throw new IllegalStateException("请关闭其他界面后再合成");
    }

    private static void fields(JsonObject body, Set<String> allowed) {
        for (String key : body.keySet()) if (!allowed.contains(key)) throw new IllegalArgumentException("不支持的合成参数：" + key);
    }

    private static String string(JsonObject body, String field) {
        var value = body.get(field);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
            || !value.getAsString().matches("[a-z0-9_.-]+:[a-z0-9_./-]{1,120}")) throw new IllegalArgumentException(field + " 必须是有效资源 ID");
        return value.getAsString();
    }

    private static int integer(JsonObject body, String key, int fallback, int min, int max) {
        if (!body.has(key)) return fallback;
        var value = body.get(key);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException(key + " 必须是整数");
        double number = value.getAsDouble();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < min || number > max) throw new IllegalArgumentException(key + " 超出允许范围");
        return (int) number;
    }

    private record Recipe(RecipeDisplayEntry entry, ItemStack output, int width, int height, List<SlotDisplay> slots) {
        int rounds(int quantity) { return (quantity + output.getCount() - 1) / output.getCount(); }
        boolean inventoryGrid() { return width <= 2 && height <= 2; }
    }

    private List<Recipe> recipes(String itemId) {
        var context = SlotDisplayContext.fromLevel(client.level);
        Map<Integer, Recipe> found = new TreeMap<>();
        for (var collection : client.player.getRecipeBook().getCollections()) for (var entry : collection.getRecipes()) {
            int width, height; List<SlotDisplay> slots;
            if (entry.display() instanceof ShapedCraftingRecipeDisplay shaped) {
                width = shaped.width(); height = shaped.height(); slots = shaped.ingredients();
            } else if (entry.display() instanceof ShapelessCraftingRecipeDisplay shapeless) {
                slots = shapeless.ingredients(); width = slots.size() <= 4 ? 2 : 3; height = width;
            } else continue; // Smelting, smithing and special recipes are separate operations.
            if (width < 1 || width > 3 || height < 1 || height > 3 || slots.size() > 9 || entry.craftingRequirements().isEmpty()) continue;
            List<ItemStack> outputs = entry.resultItems(context);
            if (outputs.size() != 1) continue;
            ItemStack output = outputs.getFirst();
            if (output.isEmpty() || !id(output).equals(itemId)) continue;
            // Net inventory delta cannot verify recipes that consume their own output item.
            if (entry.craftingRequirements().get().stream().anyMatch(ingredient -> ingredient.test(output))) continue;
            found.put(entry.id().index(), new Recipe(entry, output, width, height, slots));
        }
        return new ArrayList<>(found.values());
    }

    private boolean canCraft(Recipe recipe, int quantity) {
        List<ItemStack> inventory = new ArrayList<>();
        // Match vanilla recipe placement: only ordinary main inventory stacks are eligible.
        for (int slot = 0; slot < 36; slot++) inventory.add(client.player.getInventory().getItem(slot));
        return CraftingMaterials.canCraft(inventory, recipe.entry.craftingRequirements().orElseThrow(), recipe.rounds(quantity));
    }

    public JsonObject query(JsonObject body) {
        world(); fields(body, Set.of("itemId", "quantity", "maxResults"));
        String itemId = string(body, "itemId");
        int quantity = integer(body, "quantity", 1, 1, 64);
        int limit = integer(body, "maxResults", 16, 1, 32);
        List<Recipe> recipes = recipes(itemId);
        JsonArray values = new JsonArray();
        for (Recipe recipe : recipes) {
            if (values.size() >= limit) break;
            JsonObject json = describe(recipe, quantity);
            JsonArray ingredients = new JsonArray();
            var context = SlotDisplayContext.fromLevel(client.level);
            for (SlotDisplay display : recipe.slots) {
                JsonArray alternatives = new JsonArray();
                for (var stack : display.resolveForStacks(context).stream().limit(32).toList()) {
                    if (!stack.isEmpty()) alternatives.add(id(stack));
                }
                ingredients.add(alternatives);
            }
            json.add("ingredientSlots", ingredients);
            values.add(json);
        }
        JsonObject response = ok();
        response.addProperty("itemId", itemId); response.addProperty("dimension", client.level.dimension().identifier().toString());
        response.add("recipes", values); response.addProperty("matchedCount", recipes.size());
        response.addProperty("truncated", recipes.size() > limit);
        response.addProperty("source", "server_recipe_book");
        response.addProperty("craftingTableAvailable", findTable() != null);
        if (recipes.isEmpty()) response.addProperty("reason", "recipe_not_unlocked_or_unsupported");
        return response;
    }

    private JsonObject describe(Recipe recipe, int quantity) {
        JsonObject json = new JsonObject();
        json.addProperty("recipeId", recipe.entry.id().index()); json.addProperty("itemId", id(recipe.output));
        json.addProperty("outputPerCraft", recipe.output.getCount());
        json.addProperty("crafts", recipe.rounds(quantity)); json.addProperty("expectedOutput", recipe.rounds(quantity) * recipe.output.getCount());
        json.addProperty("width", recipe.width); json.addProperty("height", recipe.height);
        json.addProperty("station", recipe.inventoryGrid() ? "inventory" : "crafting_table");
        json.addProperty("craftable", canCraft(recipe, quantity));
        return json;
    }

    public JsonObject start(JsonObject body) {
        safe(); fields(body, Set.of("itemId", "quantity", "recipeId", "dimension"));
        if (isActive()) throw new IllegalStateException("已有合成任务正在运行");
        String itemId = string(body, "itemId");
        if (!string(body, "dimension").equals(client.level.dimension().identifier().toString())) throw new IllegalStateException("合成维度不匹配，请重新观察");
        int quantity = integer(body, "quantity", 1, 1, 64);
        int selectedId = integer(body, "recipeId", -1, 0, Integer.MAX_VALUE);
        if (!(client.player.containerMenu instanceof AbstractCraftingMenu current)
            || !(current instanceof InventoryMenu || current instanceof CraftingMenu)) throw new IllegalStateException("请关闭其他容器后再合成");
        if (!emptyGrid(current) || current.getResultSlot().hasItem()) throw new IllegalStateException("合成格中有已有物品，请先清空，避免覆盖手动操作");
        List<Recipe> candidates = recipes(itemId).stream().filter(r -> selectedId < 0 || r.entry.id().index() == selectedId)
            .sorted(Comparator.comparing((Recipe r) -> !r.inventoryGrid()).thenComparingInt(r -> r.entry.id().index())).toList();
        if (candidates.isEmpty()) throw new IllegalStateException("配方未解锁、已失效或不是支持的普通合成配方，请查询 minecraft_recipes");
        Recipe chosen = candidates.stream().filter(r -> canCraft(r, quantity)).findFirst()
            .orElseThrow(() -> new IllegalStateException("材料不足，无法完成请求数量；请查询配方并先获取材料"));
        int expected = chosen.rounds(quantity) * chosen.output.getCount();
        if (capacity(chosen.output) < expected) throw new IllegalStateException("背包空间不足，无法安全接收合成产物");
        BlockHitResult tableHit = null;
        if (current instanceof CraftingMenu) {
            tableHit = findTable();
            if (tableHit == null) throw new IllegalStateException("当前工作台不在可见交互范围内，请关闭界面后重新靠近");
        }
        if (!chosen.inventoryGrid() && !(current instanceof CraftingMenu)) {
            if (client.player.isShiftKeyDown()) throw new IllegalStateException("请先松开潜行键，以便安全打开工作台");
            tableHit = findTable();
            if (tableHit == null) throw new IllegalStateException("需要工作台：4.5 格交互距离内没有可见工作台，请先移动或放置工作台");
        }
        task = new Task(chosen, quantity, client.level, count(itemId));
        try {
            if (tableHit != null) task.table = tableHit.getBlockPos();
            if (tableHit != null && !(current instanceof CraftingMenu)) {
                task.openedTable = true; task.state = "opening_table";
                client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, tableHit);
            } else { task.menu = current; task.state = "preparing"; }
            schedule();
        } catch (Throwable failure) {
            finish("error", failure.getMessage());
            throw new IllegalStateException("启动合成失败：" + failure.getMessage(), failure);
        }
        return status();
    }

    private BlockHitResult findTable() {
        BlockPos center = client.player.blockPosition();
        List<BlockPos> candidates = new ArrayList<>();
        for (int x = -5; x <= 5; x++) for (int y = -4; y <= 4; y++) for (int z = -5; z <= 5; z++) {
            BlockPos pos = center.offset(x, y, z);
            if (client.level.isLoaded(pos) && client.level.getBlockState(pos).getBlock().builtInRegistryHolder().getRegisteredName().equals("minecraft:crafting_table")
                && client.player.getEyePosition().distanceToSqr(Vec3.atCenterOf(pos)) <= 4.5 * 4.5) candidates.add(pos);
        }
        candidates.sort(Comparator.comparingDouble(p -> client.player.getEyePosition().distanceToSqr(Vec3.atCenterOf(p))));
        for (BlockPos pos : candidates) for (Direction face : Direction.values()) {
            Vec3 aim = Vec3.atCenterOf(pos).add(face.getStepX() * .499, face.getStepY() * .499, face.getStepZ() * .499);
            BlockHitResult hit = client.level.clip(new ClipContext(client.player.getEyePosition(), aim, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, client.player));
            if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(pos)) return hit;
        }
        return null;
    }

    private void schedule() {
        if (ticker != null) ticker.cancel(false);
        Task scheduled = task; AtomicBoolean pending = new AtomicBoolean();
        ticker = executor.scheduleAtFixedRate(() -> {
            if (!pending.compareAndSet(false, true)) return;
            client.execute(() -> {
                try { if (task == scheduled) tick(); }
                finally { pending.set(false); }
            });
        }, 100, 100, TimeUnit.MILLISECONDS);
    }

    private void tick() {
        if (!isActive()) return;
        try {
            safe();
            if (client.level != task.level) throw new IllegalStateException("世界或维度已切换");
            long now = System.currentTimeMillis();
            if (now - task.startedAt > 60_000 && task.terminal == null) requestFinish("timeout", "合成任务超过 60 秒");
            if (task.menu == null) {
                if (client.player.containerMenu instanceof CraftingMenu menu) {
                    task.menu = menu;
                    if (!emptyGrid(menu) || menu.getResultSlot().hasItem()) throw new IllegalStateException("新工作台合成格并非空闲");
                    task.state = "preparing";
                } else if (now - task.startedAt > 5000) { finish("error", "服务器未打开工作台"); return; }
                else return;
            }
            if (client.player.containerMenu != task.menu) throw new IllegalStateException("容器已切换，已停止合成");
            if (task.table != null && (client.player.getEyePosition().distanceToSqr(Vec3.atCenterOf(task.table)) > 4.5 * 4.5
                || !client.level.getBlockState(task.table).getBlock().builtInRegistryHolder().getRegisteredName().equals("minecraft:crafting_table"))) throw new IllegalStateException("工作台已离开交互范围或被破坏");
            if (task.terminal != null) { cleanup(now); return; }
            if (task.state.equals("preparing")) {
                if (!emptyGrid(task.menu) || task.menu.getResultSlot().hasItem()) throw new IllegalStateException("合成格被外部操作改变");
                if (!canCraft(task.recipe, task.quantity - task.produced)) throw new IllegalStateException("材料已变化或不足");
                if (capacity(task.recipe.output) < task.recipe.output.getCount()) throw new IllegalStateException("背包已无产物空间");
                task.baseline = count(id(task.recipe.output));
                task.phaseAt = now;
                client.gameMode.handlePlaceRecipe(task.menu.containerId, task.recipe.entry.id(), false);
                task.recipePending = true;
                task.state = "waiting_recipe";
            } else if (task.state.equals("waiting_recipe")) {
                var output = task.menu.getResultSlot().getItem();
                if (!output.isEmpty()) {
                    task.recipePending = false;
                    if (!ItemStack.isSameItemSameComponents(output, task.recipe.output) || output.getCount() != task.recipe.output.getCount()) throw new IllegalStateException("服务器返回了非预期合成产物");
                    // One recipe placement must contain only one batch; otherwise QUICK_MOVE could over-craft.
                    for (var slot : task.menu.getInputGridSlots()) if (slot.getItem().getCount() > 1) throw new IllegalStateException("合成格包含多批材料，已拒绝批量取出");
                    client.gameMode.handleContainerInput(task.menu.containerId, task.menu.getResultSlot().index, 0, ContainerInput.QUICK_MOVE, client.player);
                    task.state = "verifying"; task.phaseAt = now;
                } else if (now - task.phaseAt > 5000) throw new IllegalStateException("服务器未填充配方：材料或配方可能已变化");
            } else if (task.state.equals("verifying")) {
                int delta = count(id(task.recipe.output)) - task.baseline;
                if (delta == task.recipe.output.getCount() && now - task.phaseAt >= 600) {
                    task.produced += delta; task.batches++;
                    if (task.produced >= task.quantity) requestFinish("completed", "已读回背包中的合成产物");
                    else { task.state = "between_batches"; task.phaseAt = now; }
                } else if (now - task.phaseAt > 5000) throw new IllegalStateException("背包未确认预期产物，停止重试以避免重复合成");
            } else if (task.state.equals("between_batches")) {
                if (!emptyGrid(task.menu)) {
                    if (!task.batchCleanupSent) {
                        for (var slot : task.menu.getInputGridSlots()) if (slot.hasItem()) client.gameMode.handleContainerInput(task.menu.containerId, slot.index, 0, ContainerInput.QUICK_MOVE, client.player);
                        task.batchCleanupSent = true;
                    }
                    if (now - task.phaseAt > 3000) throw new IllegalStateException("批次余料无法安全回收，请检查合成格");
                    return;
                }
                if (now - task.phaseAt >= 600) { task.batchCleanupSent = false; task.state = "preparing"; }
            }
        } catch (Throwable failure) {
            // Do not click another menu or discard anything when ownership/safety is lost.
            if (task != null) { task.recoveryRequired = task.recipePending || task.menu != null && !emptyGrid(task.menu); finish("safety_stop", failure.getMessage()); }
        }
    }

    private void requestFinish(String state, String message) {
        if (task.terminal != null) return;
        task.terminal = state; task.message = message; task.cleanupAt = System.currentTimeMillis(); task.state = "cleanup";
    }

    private void cleanup(long now) {
        if (task.recipePending) {
            // A cancel cannot recall the recipe packet. Wait for its server response
            // before considering an apparently empty grid safe to close.
            if (!emptyGrid(task.menu) || task.menu.getResultSlot().hasItem()) task.recipePending = false;
            else if (now - task.cleanupAt <= 4000) return;
            else {
                task.recoveryRequired = true;
                finish("error", "填料请求仍未确认，请手动检查合成格，禁止自动重试");
                return;
            }
        }
        if (now - task.cleanupAt > 4000) {
            task.recoveryRequired = !emptyGrid(task.menu);
            finish(task.recoveryRequired ? "error" : task.terminal, task.recoveryRequired ? "剩余材料未安全回收，请手动检查合成格" : task.message);
            return;
        }
        if (!emptyGrid(task.menu)) {
            if (!task.cleanupSent) {
                for (var slot : task.menu.getInputGridSlots()) if (slot.hasItem()) client.gameMode.handleContainerInput(task.menu.containerId, slot.index, 0, ContainerInput.QUICK_MOVE, client.player);
                task.cleanupSent = true;
            }
            return;
        }
        if (now - task.cleanupAt < 600) return;
        // Close only a table opened by this operation, after materials are safely back.
        if (task.openedTable) client.player.closeContainer();
        finish(task.terminal, task.message);
    }

    private void finish(String state, String message) {
        if (client.player != null && client.level == task.level) task.inventoryAfter = count(id(task.recipe.output));
        if (state.equals("completed") && task.inventoryAfter - task.inventoryBefore < task.produced) {
            state = "error"; message = "最终背包数量与已确认产物不符，请重新检查背包";
        }
        task.active = false; task.state = state; task.message = message;
        if (ticker != null) { ticker.cancel(false); ticker = null; }
    }

    public JsonObject cancel(String id) {
        if (task == null || !task.id.equals(id)) throw new IllegalStateException("合成操作 ID 不匹配");
        if (isActive()) requestFinish("cancelled", "用户取消合成；已完成的产物不会撤销");
        return status();
    }

    public JsonObject status() {
        JsonObject response = ok(); response.addProperty("status", task == null ? "idle" : task.state);
        if (task != null) response.add("craft", task.json());
        return response;
    }

    private static boolean emptyGrid(AbstractCraftingMenu menu) { return menu.getInputGridSlots().stream().noneMatch(slot -> slot.hasItem()); }
    private static String id(ItemStack stack) { return stack.getItem().builtInRegistryHolder().getRegisteredName(); }
    private int count(String itemId) {
        int total = 0;
        for (int slot = 0; slot < 36; slot++) { var stack = client.player.getInventory().getItem(slot); if (!stack.isEmpty() && id(stack).equals(itemId)) total += stack.getCount(); }
        return total;
    }
    private int capacity(ItemStack output) {
        int space = 0;
        for (int slot = 0; slot < 36; slot++) {
            var stack = client.player.getInventory().getItem(slot);
            if (stack.isEmpty()) space += output.getMaxStackSize();
            else if (ItemStack.isSameItemSameComponents(stack, output)) space += Math.max(0, stack.getMaxStackSize() - stack.getCount());
        }
        return space;
    }
    private static JsonObject ok() { JsonObject response = new JsonObject(); response.addProperty("ok", true); return response; }

    private static final class Task {
        final String id = UUID.randomUUID().toString();
        final Recipe recipe; final int quantity; final ClientLevel level; final int inventoryBefore;
        final long startedAt = System.currentTimeMillis();
        boolean active = true, openedTable, cleanupSent, batchCleanupSent, recoveryRequired, recipePending;
        int baseline, produced, batches, inventoryAfter = -1;
        long phaseAt, cleanupAt;
        String state = "preparing", terminal, message = "正在合成";
        AbstractCraftingMenu menu; BlockPos table;
        Task(Recipe recipe, int quantity, ClientLevel level, int inventoryBefore) { this.recipe = recipe; this.quantity = quantity; this.level = level; this.inventoryBefore = inventoryBefore; }
        JsonObject json() {
            JsonObject json = new JsonObject();
            json.addProperty("id", id); json.addProperty("state", state); json.addProperty("active", active); json.addProperty("message", message);
            json.addProperty("itemId", CraftingController.id(recipe.output)); json.addProperty("recipeId", recipe.entry.id().index());
            json.addProperty("requestedQuantity", quantity); json.addProperty("produced", produced); json.addProperty("batches", batches);
            json.addProperty("expectedOutput", recipe.rounds(quantity) * recipe.output.getCount());
            json.addProperty("inventoryBefore", inventoryBefore); json.addProperty("startedAt", startedAt);
            if (inventoryAfter >= 0) json.addProperty("inventoryAfter", inventoryAfter);
            json.addProperty("recoveryRequired", recoveryRequired); json.addProperty("verification", "client_snapshot");
            return json;
        }
    }
}
