package com.minecraffai.mod;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import org.slf4j.Logger;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public final class MinecraftAiClient implements ClientModInitializer {
    private static final Logger LOGGER = LogUtils.getLogger();
    private static final int MAX_BODY_BYTES = 16 * 1024;
    private static final int MAX_MESSAGE_LENGTH = 256;
    private static final String LOOPBACK_HOST = "127.0.0.1";

    private Minecraft client;
    private HttpServer server;
    private Path registryFile;
    private String instanceId;
    private String token;
    private int port;
    private ScheduledExecutorService miningExecutor;
    private ScheduledFuture<?> miningTicker;
    private MiningTask miningTask;

    @Override
    public void onInitializeClient() {
        client = Minecraft.getInstance();
        try {
            startApi();
            Runtime.getRuntime().addShutdownHook(new Thread(this::stopApi, "minecraft-ai-api-shutdown"));
            LOGGER.info("Minecraft AI local API started on {}:{}", LOOPBACK_HOST, port);
        } catch (Exception error) {
            LOGGER.error("Minecraft AI local API failed to start", error);
        }
    }

    private void startApi() throws IOException {
        instanceId = Long.toString(ProcessHandle.current().pid());
        token = randomToken();
        int requestedPort = configuredPort();
        server = HttpServer.create(new InetSocketAddress(LOOPBACK_HOST, requestedPort), 0);
        server.createContext("/health", exchange -> withAuth(exchange, this::handleHealth));
        server.createContext("/state", exchange -> withAuth(exchange, this::handleState));
        server.createContext("/inventory", exchange -> withAuth(exchange, this::handleInventory));
        server.createContext("/environment", exchange -> withAuth(exchange, this::handleEnvironment));
        server.createContext("/mining/start", exchange -> withAuth(exchange, this::handleMiningStart));
        server.createContext("/mining/status", exchange -> withAuth(exchange, this::handleMiningStatus));
        server.createContext("/mining/stop", exchange -> withAuth(exchange, this::handleMiningStop));
        server.createContext("/chat", exchange -> withAuth(exchange, this::handleChat));
        server.setExecutor(Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "minecraft-ai-api");
            thread.setDaemon(true);
            return thread;
        }));
        server.start();
        miningExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "minecraft-ai-mining");
            thread.setDaemon(true);
            return thread;
        });
        port = server.getAddress().getPort();
        writeRegistry();
    }

    private int configuredPort() {
        String configured = System.getProperty("minecraft.ai.port", System.getenv("MC_AI_MOD_PORT"));
        if (configured == null || configured.isBlank()) return 0;
        try {
            int value = Integer.parseInt(configured);
            return value >= 0 && value <= 65535 ? value : 0;
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private void writeRegistry() throws IOException {
        Path directory = FabricLoader.getInstance().getGameDir().resolve("minecraft-ai").resolve("windows");
        Files.createDirectories(directory);
        registryFile = directory.resolve(instanceId + ".json");
        JsonObject registry = new JsonObject();
        registry.addProperty("id", instanceId);
        registry.addProperty("host", LOOPBACK_HOST);
        registry.addProperty("port", port);
        registry.addProperty("token", token);
        registry.addProperty("title", safeTitle());
        registry.addProperty("minecraftVersion", "26.2");
        registry.addProperty("apiVersion", 1);
        registry.addProperty("updatedAt", Instant.now().toString());
        Path temporary = registryFile.resolveSibling(registryFile.getFileName() + ".tmp");
        Files.writeString(temporary, registry.toString(), StandardCharsets.UTF_8);
        try {
            Files.move(temporary, registryFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, registryFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void stopApi() {
        stopMiningTicker();
        if (miningExecutor != null) miningExecutor.shutdownNow();
        if (server != null) server.stop(0);
        if (registryFile != null) {
            try { Files.deleteIfExists(registryFile); } catch (IOException error) { LOGGER.debug("Could not remove registry file", error); }
        }
    }

    private void withAuth(HttpExchange exchange, HttpHandler handler) throws IOException {
        String authorization = exchange.getRequestHeaders().getFirst("Authorization");
        if (!("Bearer " + token).equals(authorization)) {
            respond(exchange, 401, error("未授权的本地请求"));
            return;
        }
        handler.handle(exchange);
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 GET"));
            return;
        }
        JsonObject response = baseResponse();
        response.addProperty("title", safeTitle());
        response.addProperty("connected", client.player != null && client.level != null);
        respond(exchange, 200, response);
    }

    private void handleState(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 GET"));
            return;
        }
        JsonObject response = baseResponse();
        response.addProperty("connected", client.player != null && client.level != null);
        response.addProperty("observedAt", Instant.now().toString());
        String activity = currentActivity();
        response.addProperty("activity", activity);
        response.addProperty("activityText", activityText(activity));
        if (client.player != null) response.addProperty("spectator", client.player.isSpectator());
        if (client.gameMode != null && client.gameMode.getPlayerMode() != null) {
            response.addProperty("gameMode", client.gameMode.getPlayerMode().getName());
        }
        if (client.player != null) response.addProperty("player", client.player.getName().getString());
        if (client.level != null) response.addProperty("world", client.level.dimension().identifier().toString());
        if (miningTask != null) response.add("mining", miningTask.toJson());
        respond(exchange, 200, response);
    }

    private String currentActivity() {
        if (client.player == null || client.level == null) return "disconnected";
        if (miningTask != null && miningTask.isActive()) return "mining";
        if (client.gameMode != null && client.gameMode.isDestroying()) return "breaking";
        if (client.player.input != null && client.player.input.hasForwardImpulse()) return "moving";
        return "idle";
    }

    private String activityText(String activity) {
        return switch (activity) {
            case "mining" -> "正在执行挖矿任务";
            case "breaking" -> "正在破坏方块";
            case "moving" -> "正在移动";
            case "idle" -> "当前没有自动动作";
            default -> "Minecraft 尚未进入世界";
        };
    }

    private void handleChat(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        try {
            JsonObject body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
            String message = body.has("message") ? body.get("message").getAsString().trim() : "";
            if (message.isEmpty()) throw new IllegalArgumentException("消息不能为空");
            if (message.length() > MAX_MESSAGE_LENGTH) throw new IllegalArgumentException("消息长度不能超过 256 个字符");
            if (message.contains("\r") || message.contains("\n")) throw new IllegalArgumentException("消息不能包含换行");
            if (client.player == null || client.level == null) {
                respond(exchange, 409, error("Minecraft 尚未进入世界"));
                return;
            }

            CompletableFuture<JsonObject> result = new CompletableFuture<>();
            client.execute(() -> {
                try {
                    if (client.player == null || client.level == null) throw new IllegalStateException("Minecraft 尚未进入世界");
                    client.player.connection.sendChat(message);
                    JsonObject response = baseResponse();
                    response.addProperty("sent", message);
                    result.complete(response);
                } catch (Throwable error) {
                    result.completeExceptionally(error);
                }
            });
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException error) {
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "请求无效" : error.getMessage()));
        }
    }

    private void handleInventory(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 GET"));
            return;
        }
        if (client.player == null || client.level == null) {
            respond(exchange, 409, error("Minecraft 尚未进入世界"));
            return;
        }

        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            try {
                if (client.player == null || client.level == null) throw new IllegalStateException("Minecraft 尚未进入世界");
                var inventory = client.player.getInventory();
                JsonArray items = new JsonArray();
                for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
                    var stack = inventory.getItem(slot);
                    if (stack.isEmpty()) continue;
                    JsonObject item = new JsonObject();
                    item.addProperty("slot", slot);
                    item.addProperty("itemId", stack.getItem().builtInRegistryHolder().getRegisteredName());
                    item.addProperty("name", stack.getHoverName().getString());
                    item.addProperty("count", stack.getCount());
                    item.addProperty("selected", slot == inventory.getSelectedSlot());
                    items.add(item);
                }
                JsonObject response = baseResponse();
                response.addProperty("player", client.player.getName().getString());
                response.addProperty("selectedSlot", inventory.getSelectedSlot());
                response.addProperty("slotCount", inventory.getContainerSize());
                response.add("items", items);
                result.complete(response);
            } catch (Throwable error) {
                result.completeExceptionally(error);
            }
        });
        try {
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException error) {
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "请求无效" : error.getMessage()));
        }
    }

    private void handleEnvironment(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 GET"));
            return;
        }
        if (client.player == null || client.level == null) {
            respond(exchange, 409, error("Minecraft 尚未进入世界"));
            return;
        }

        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            try {
                if (client.player == null || client.level == null) throw new IllegalStateException("Minecraft 尚未进入世界");
                var player = client.player;
                var level = client.level;
                var position = player.position();
                JsonObject response = baseResponse();
                response.addProperty("player", player.getName().getString());
                response.addProperty("dimension", level.dimension().identifier().toString());
                JsonObject coordinates = new JsonObject();
                coordinates.addProperty("x", position.x());
                coordinates.addProperty("y", position.y());
                coordinates.addProperty("z", position.z());
                response.add("position", coordinates);
                response.addProperty("yaw", player.getYRot());
                response.addProperty("pitch", player.getXRot());
                response.addProperty("health", player.getHealth());
                response.addProperty("food", player.getFoodData().getFoodLevel());
                response.addProperty("saturation", player.getFoodData().getSaturationLevel());
                response.addProperty("onGround", player.onGround());

                JsonArray entities = new JsonArray();
                for (var entity : level.getEntities(player, player.getBoundingBox().inflate(8.0), candidate -> candidate != player)) {
                    if (entities.size() >= 64) break;
                    JsonObject item = new JsonObject();
                    item.addProperty("type", entity.getType().builtInRegistryHolder().getRegisteredName());
                    item.addProperty("name", entity.getName().getString());
                    item.addProperty("distance", Math.sqrt(entity.distanceToSqr(player)));
                    item.addProperty("x", entity.getX());
                    item.addProperty("y", entity.getY());
                    item.addProperty("z", entity.getZ());
                    entities.add(item);
                }
                response.add("nearbyEntities", entities);

                JsonArray blocks = new JsonArray();
                BlockPos center = BlockPos.containing(position);
                for (int y = -1; y <= 1; y++) {
                    for (int x = -1; x <= 1; x++) {
                        for (int z = -1; z <= 1; z++) {
                            BlockPos blockPos = center.offset(x, y, z);
                            var block = level.getBlockState(blockPos).getBlock();
                            JsonObject item = new JsonObject();
                            item.addProperty("x", blockPos.getX());
                            item.addProperty("y", blockPos.getY());
                            item.addProperty("z", blockPos.getZ());
                            item.addProperty("blockId", block.builtInRegistryHolder().getRegisteredName());
                            blocks.add(item);
                        }
                    }
                }
                response.add("nearbyBlocks", blocks);
                result.complete(response);
            } catch (Throwable error) {
                result.completeExceptionally(error);
            }
        });
        try {
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException error) {
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "请求无效" : error.getMessage()));
        }
    }

    private void handleMiningStart(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        try {
            MiningPlan plan = parseMiningPlan(JsonParser.parseString(readBody(exchange)).getAsJsonObject());
            CompletableFuture<JsonObject> result = new CompletableFuture<>();
            client.execute(() -> {
                try {
                    if (client.player == null || client.level == null || client.gameMode == null) {
                        throw new IllegalStateException("Minecraft 尚未进入可操作的世界");
                    }
                    if (miningTask != null && miningTask.isActive()) {
                        throw new IllegalStateException("已有挖矿任务正在运行");
                    }
                    stopMiningTicker();
                    miningTask = new MiningTask(plan);
                    miningTask.forwardWasDown = client.options.keyUp.isDown();
                    miningTicker = miningExecutor.scheduleAtFixedRate(() -> client.execute(this::tickMining), 0, 150, TimeUnit.MILLISECONDS);
                    result.complete(miningStatusResponse());
                } catch (Throwable error) {
                    result.completeExceptionally(error);
                }
            });
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException error) {
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "挖矿参数无效" : error.getMessage()));
        }
    }

    private void handleMiningStatus(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 GET"));
            return;
        }
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            try { result.complete(miningStatusResponse()); }
            catch (Throwable error) { result.completeExceptionally(error); }
        });
        try {
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException error) {
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "无法读取挖矿状态" : error.getMessage()));
        }
    }

    private void handleMiningStop(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            try {
                if (miningTask != null && miningTask.isActive()) miningTask.finish("stopped", "任务已由用户停止");
                stopMiningTicker();
                result.complete(miningStatusResponse());
            } catch (Throwable error) { result.completeExceptionally(error); }
        });
        try {
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException error) {
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "无法停止挖矿" : error.getMessage()));
        }
    }

    private void tickMining() {
        MiningTask task = miningTask;
        if (task == null || !task.isActive()) return;
        if (client.player == null || client.level == null || client.gameMode == null) {
            task.finish("stopped", "Minecraft 已离开世界");
            stopMiningTicker();
            return;
        }
        if (System.currentTimeMillis() - task.startedAt >= task.plan.maxMinutes * 60_000L) {
            task.finish("timeout", "达到最大运行时间");
            stopMiningTicker();
            return;
        }
        if (task.broken >= task.plan.quantity) {
            task.finish("completed", "已达到目标数量");
            stopMiningTicker();
            return;
        }
        if (task.broken >= task.plan.maxBlocks) {
            task.finish("limit_reached", "达到最大挖掘方块数");
            stopMiningTicker();
            return;
        }
        if (client.player.getHealth() <= 6.0F) {
            task.finish("safety_stop", "生命值过低");
            stopMiningTicker();
            return;
        }
        if (client.player.getFoodData().getFoodLevel() <= 6) {
            task.finish("safety_stop", "饥饿值过低");
            stopMiningTicker();
            return;
        }
        if (client.player.isInLava()) {
            task.finish("safety_stop", "玩家进入岩浆");
            stopMiningTicker();
            return;
        }
        if (client.player.isSpectator()) {
            task.finish("safety_stop", "不能处于旁观模式");
            stopMiningTicker();
            return;
        }
        if (task.plan.returnWhenFull && inventoryFull()) {
            task.finish("inventory_full", "背包已满");
            stopMiningTicker();
            return;
        }
        BlockPos target = findMiningTarget(task);
        if (target == null) {
            task.state = "waiting_target";
            task.currentTarget = null;
            releaseForwardInput();
            return;
        }
        task.currentTarget = target;
        double distance = Math.sqrt(client.player.distanceToSqr(target.getX() + 0.5, target.getY() + 0.5, target.getZ() + 0.5));
        if (distance > 4.0) {
            moveTowardTarget(task, target, distance);
            return;
        }
        releaseForwardInput();
        task.state = "breaking";
        try {
            var targetState = client.level.getBlockState(target);
            if (!selectToolForTarget(targetState, target)) {
                task.finish("safety_stop", "快捷栏中没有能破坏目标方块的工具");
                stopMiningTicker();
                return;
            }
            String targetId = targetState.getBlock().builtInRegistryHolder().getRegisteredName();
            if (client.gameMode.destroyBlock(target)) {
                task.broken += 1;
                task.lastTarget = target;
                task.lastTargetId = targetId;
            }
        } catch (Throwable error) {
            task.finish("error", error.getMessage() == null ? "挖掘失败" : error.getMessage());
            stopMiningTicker();
        }
    }

    private void moveTowardTarget(MiningTask task, BlockPos target, double distance) {
        if (task.lastDistance > 0.0 && distance >= task.lastDistance - 0.02) task.stalledTicks += 1;
        else task.stalledTicks = 0;
        task.lastDistance = distance;
        if (task.stalledTicks >= 40) {
            task.finish("stuck", "无法安全靠近目标方块");
            stopMiningTicker();
            return;
        }
        double dx = target.getX() + 0.5 - client.player.getX();
        double dz = target.getZ() + 0.5 - client.player.getZ();
        float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
        client.player.setYRot(yaw);
        client.options.keyUp.setDown(true);
        task.state = "moving";
    }

    private void releaseForwardInput() {
        if (miningTask == null) return;
        client.options.keyUp.setDown(miningTask.forwardWasDown);
    }

    private boolean selectToolForTarget(net.minecraft.world.level.block.state.BlockState targetState, BlockPos target) {
        var inventory = client.player.getInventory();
        for (int slot = 0; slot < 9; slot++) {
            var stack = inventory.getItem(slot);
            if (stack.isEmpty()) continue;
            if (stack.canDestroyBlock(targetState, client.level, target, client.player)) {
                inventory.setSelectedSlot(slot);
                return true;
            }
        }
        return false;
    }

    private BlockPos findMiningTarget(MiningTask task) {
        BlockPos center = client.player.blockPosition();
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (int y = -5; y <= 5; y++) {
            for (int x = -5; x <= 5; x++) {
                for (int z = -5; z <= 5; z++) {
                    BlockPos candidate = center.offset(x, y, z);
                    if (!client.level.isLoaded(candidate)) continue;
                    var state = client.level.getBlockState(candidate);
                    if (state.isAir()) continue;
                    String id = state.getBlock().builtInRegistryHolder().getRegisteredName();
                    if (!task.plan.targetBlocks.contains(id)) continue;
                    double distance = client.player.distanceToSqr(candidate.getX() + 0.5, candidate.getY() + 0.5, candidate.getZ() + 0.5);
                    if (distance > 25.0 || distance >= bestDistance) continue;
                    best = candidate;
                    bestDistance = distance;
                }
            }
        }
        return best;
    }

    private boolean inventoryFull() {
        var inventory = client.player.getInventory();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            if (inventory.getItem(slot).isEmpty()) return false;
        }
        return true;
    }

    private void stopMiningTicker() {
        releaseForwardInput();
        if (miningTicker != null) {
            miningTicker.cancel(false);
            miningTicker = null;
        }
    }

    private JsonObject miningStatusResponse() {
        JsonObject response = baseResponse();
        if (miningTask == null) {
            response.addProperty("status", "idle");
            return response;
        }
        response.add("mining", miningTask.toJson());
        response.addProperty("status", miningTask.state);
        return response;
    }

    private MiningPlan parseMiningPlan(JsonObject body) {
        if (body == null) throw new IllegalArgumentException("挖矿参数不能为空");
        String strategy = body.has("strategy") ? body.get("strategy").getAsString().trim().toLowerCase(Locale.ROOT) : "ore";
        if (!strategy.equals("ore") && !strategy.equals("nearby")) throw new IllegalArgumentException("第一阶段只支持 ore 或 nearby 模式");
        Set<String> targets = new HashSet<>();
        if (body.has("targetBlocks") && body.get("targetBlocks").isJsonArray()) {
            for (var item : body.getAsJsonArray("targetBlocks")) {
                String id = item.getAsString().trim().toLowerCase(Locale.ROOT);
                if (!id.matches("minecraft:[a-z0-9_./-]+")) throw new IllegalArgumentException("目标方块 ID 无效");
                targets.add(id);
            }
        }
        if (targets.isEmpty()) { targets.add("minecraft:coal_ore"); targets.add("minecraft:iron_ore"); }
        if (targets.size() > 8) throw new IllegalArgumentException("最多只能指定 8 个目标方块");
        int quantity = integerField(body, "quantity", 1, 256, 1);
        double maxMinutes = numberField(body, "maxMinutes", 0.01, 30.0, 10.0);
        int maxBlocks = integerField(body, "maxBlocks", 1, 512, 256);
        boolean returnWhenFull = body.has("returnWhenFull") && body.get("returnWhenFull").getAsBoolean();
        return new MiningPlan(strategy, targets, quantity, maxMinutes, maxBlocks, returnWhenFull);
    }

    private int integerField(JsonObject body, String name, int min, int max, int fallback) {
        int value = body.has(name) ? body.get(name).getAsInt() : fallback;
        if (value < min || value > max) throw new IllegalArgumentException(name + " 超出允许范围");
        return value;
    }

    private double numberField(JsonObject body, String name, double min, double max, double fallback) {
        double value = body.has(name) ? body.get(name).getAsDouble() : fallback;
        if (!Double.isFinite(value) || value < min || value > max) throw new IllegalArgumentException(name + " 超出允许范围");
        return value;
    }

    private String readBody(HttpExchange exchange) throws IOException {
        try (InputStream input = exchange.getRequestBody()) {
            byte[] buffer = new byte[MAX_BODY_BYTES + 1];
            int offset = 0;
            int read;
            while ((read = input.read(buffer, offset, buffer.length - offset)) != -1) {
                offset += read;
                if (offset > MAX_BODY_BYTES) throw new IllegalArgumentException("请求体过大");
                if (offset == buffer.length) break;
            }
            return new String(buffer, 0, offset, StandardCharsets.UTF_8);
        }
    }

    private JsonObject baseResponse() {
        JsonObject response = new JsonObject();
        response.addProperty("ok", true);
        response.addProperty("id", instanceId);
        return response;
    }

    private JsonObject error(String message) {
        JsonObject response = new JsonObject();
        response.addProperty("ok", false);
        response.addProperty("error", message);
        return response;
    }

    private void respond(HttpExchange exchange, int status, JsonObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }

    private String safeTitle() {
        return "Minecraft 26.2 · " + instanceId;
    }

    private record MiningPlan(String strategy, Set<String> targetBlocks, int quantity, double maxMinutes, int maxBlocks, boolean returnWhenFull) {}

    private static final class MiningTask {
        private final MiningPlan plan;
        private final long startedAt = System.currentTimeMillis();
        private int broken;
        private String state = "running";
        private String message = "任务已启动";
        private BlockPos currentTarget;
        private BlockPos lastTarget;
        private String lastTargetId;
        private boolean forwardWasDown;
        private double lastDistance;
        private int stalledTicks;

        private MiningTask(MiningPlan plan) { this.plan = plan; }

        private boolean isActive() {
            return Set.of("running", "moving", "breaking", "waiting_target").contains(state);
        }

        private void finish(String state, String message) {
            this.state = state;
            this.message = message;
            this.currentTarget = null;
        }

        private JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("state", state);
            json.addProperty("message", message);
            json.addProperty("strategy", plan.strategy());
            json.addProperty("quantity", plan.quantity());
            json.addProperty("broken", broken);
            json.addProperty("maxBlocks", plan.maxBlocks());
            json.addProperty("maxMinutes", plan.maxMinutes());
            json.addProperty("startedAt", startedAt);
            json.addProperty("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
            JsonArray targets = new JsonArray();
            plan.targetBlocks().forEach(targets::add);
            json.add("targetBlocks", targets);
            if (currentTarget != null) json.add("currentTarget", blockPositionJson(currentTarget));
            if (lastTarget != null) {
                json.add("lastTarget", blockPositionJson(lastTarget));
                if (lastTargetId != null) json.addProperty("lastTargetId", lastTargetId);
            }
            return json;
        }

        private static JsonObject blockPositionJson(BlockPos pos) {
            JsonObject json = new JsonObject();
            json.addProperty("x", pos.getX());
            json.addProperty("y", pos.getY());
            json.addProperty("z", pos.getZ());
            return json;
        }
    }

    private String randomToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
