package com.minecraffai.mod;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import org.slf4j.Logger;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
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
import java.util.List;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.Comparator;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public final class MinecraftAiClient implements ClientModInitializer {
    private static final Logger LOGGER = LogUtils.getLogger();
    private static final int MAX_BODY_BYTES = 16 * 1024;
    private static final int MAX_AUDIO_BYTES = 4 * 1024 * 1024;
    private static final int MAX_AUDIO_SECONDS = 30;
    private static final int VOICE_SAMPLE_RATE = 48_000;
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
    private ScheduledExecutorService voiceExecutor;
    private final AtomicInteger queuedVoiceTasks = new AtomicInteger();
    private Object plasmoVoiceLoopback;
    private volatile String voiceTaskState = "idle";
    private volatile String voiceTaskError;
    private volatile String voiceTaskMode;
    private volatile int voiceFramesSent;
    private volatile String voiceTaskUpdatedAt;
    private MiningTask miningTask;
    private ScheduledFuture<?> followTicker;
    private ScheduledFuture<?> atomicTicker;
    private AtomicTask atomicTask;
    private ScheduledFuture<?> moveTicker;
    private MoveTask moveTask;
    private CraftingController crafting;
    private FollowTask followTask;
    private boolean followIgnoreSafetyDefault;
    private static final double PLAYER_SCAN_RADIUS = 32.0;
    private static final Set<String> FOLLOW_HAZARDS = Set.of("minecraft:fire", "minecraft:soul_fire", "minecraft:magma_block", "minecraft:cactus",
        "minecraft:campfire", "minecraft:soul_campfire", "minecraft:powder_snow", "minecraft:sweet_berry_bush", "minecraft:wither_rose");

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
        server.createContext("/blocks/scan", exchange -> withAuth(exchange, this::handleBlockScan));
        server.createContext("/blocks/break", exchange -> withAuth(exchange, this::handleBlockBreak));
        server.createContext("/blocks/place", exchange -> withAuth(exchange, this::handleBlockPlace));
        server.createContext("/blocks/status", exchange -> withAuth(exchange, e -> followRequest(e, "GET", this::atomicStatusResponse)));
        server.createContext("/blocks/stop", exchange -> withAuth(exchange, e -> handleOperationStop(e, false)));
        server.createContext("/move/start", exchange -> withAuth(exchange, this::handleMoveStart));
        server.createContext("/move/status", exchange -> withAuth(exchange, e -> followRequest(e, "GET", this::moveStatusResponse)));
        server.createContext("/move/stop", exchange -> withAuth(exchange, e -> handleOperationStop(e, true)));
        server.createContext("/craft/recipes", exchange -> withAuth(exchange, e -> handleCraftRequest(e, "recipes")));
        server.createContext("/craft/start", exchange -> withAuth(exchange, e -> handleCraftRequest(e, "start")));
        server.createContext("/craft/status", exchange -> withAuth(exchange, e -> followRequest(e, "GET", crafting::status)));
        server.createContext("/craft/stop", exchange -> withAuth(exchange, e -> handleCraftRequest(e, "stop")));
        server.createContext("/mining/start", exchange -> withAuth(exchange, this::handleMiningStart));
        server.createContext("/mining/status", exchange -> withAuth(exchange, this::handleMiningStatus));
        server.createContext("/mining/stop", exchange -> withAuth(exchange, this::handleMiningStop));
        server.createContext("/players", exchange -> withAuth(exchange, this::handlePlayers));
        server.createContext("/follow/start", exchange -> withAuth(exchange, this::handleFollowStart));
        server.createContext("/follow/status", exchange -> withAuth(exchange, this::handleFollowStatus));
        server.createContext("/follow/stop", exchange -> withAuth(exchange, this::handleFollowStop));
        server.createContext("/follow/safety", exchange -> withAuth(exchange, this::handleFollowSafety));
        server.createContext("/chat", exchange -> withAuth(exchange, this::handleChat));
        server.createContext("/voice", exchange -> withAuth(exchange, this::handleVoice));
        server.setExecutor(Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "minecraft-ai-api");
            thread.setDaemon(true);
            return thread;
        }));
        miningExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "minecraft-ai-mining");
            thread.setDaemon(true);
            return thread;
        });
        crafting = new CraftingController(client, miningExecutor);
        voiceExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "minecraft-ai-voice");
            thread.setDaemon(true);
            return thread;
        });
        server.start();
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
        if (crafting != null) crafting.shutdown();
        if (atomicTicker != null) atomicTicker.cancel(false);
        if (moveTicker != null) moveTicker.cancel(false);
        stopMiningTicker();
        stopFollowTicker();
        if (miningExecutor != null) miningExecutor.shutdownNow();
        if (voiceExecutor != null) voiceExecutor.shutdownNow();
        closeVoiceSource();
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
        response.addProperty("atomicActionsVersion", 1);
        response.addProperty("craftingVersion", 1);
        respond(exchange, 200, response);
    }

    private void handleState(HttpExchange exchange) throws IOException {
        followRequest(exchange, "GET", this::stateResponse);
    }

    private JsonObject stateResponse() {
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
        if (followTask != null) response.add("follow", followTask.toJson());
        if (moveTask != null) response.add("move", moveTask.toJson());
        if (atomicTask != null) response.add("action", atomicTask.toJson());
        if (crafting != null && crafting.status().has("craft")) response.add("craft", crafting.status().get("craft"));
        return response;
    }

    private String currentActivity() {
        if (client.player == null || client.level == null) return "disconnected";
        if (miningTask != null && miningTask.isActive()) return "mining";
        if (followTask != null && followTask.isActive()) return "following";
        if (crafting != null && crafting.isActive()) return "crafting";
        if (moveTask != null && moveTask.active) return "moving";
        if (atomicTask != null && atomicTask.active) return atomicTask.kind.equals("break") ? "breaking" : "placing";
        if (client.gameMode != null && client.gameMode.isDestroying()) return "breaking";
        if (client.player.input != null && client.player.input.hasForwardImpulse()) return "moving";
        return "idle";
    }

    private String activityText(String activity) {
        return switch (activity) {
            case "mining" -> "正在执行挖矿任务";
            case "following" -> followTask == null ? "正在执行跟随任务" : followTask.message;
            case "breaking" -> "正在破坏方块";
            case "moving" -> "正在移动";
            case "crafting" -> "正在执行合成任务";
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

    /** Reports the real voice transport state; POST completes only after playback/transmission. */
    private void handleVoice(HttpExchange exchange) throws IOException {
        if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            JsonObject response = baseResponse();
            response.addProperty("voiceBridgeVersion", 2);
            response.addProperty("state", voiceTaskState);
            response.addProperty("mode", voiceTaskMode);
            response.addProperty("framesSent", voiceFramesSent);
            response.addProperty("lastError", voiceTaskError);
            response.addProperty("updatedAt", voiceTaskUpdatedAt);
            try {
                var context = PlasmoVoiceBridge.prepare(plasmoVoiceClient());
                response.addProperty("microphoneReady", true);
                response.addProperty("channel", String.valueOf(PlasmoVoiceBridge.call(context.activation(), "getName")));
                response.addProperty("distance", ((Number) PlasmoVoiceBridge.call(context.activation(), "getDistance")).intValue());
                response.addProperty("captureSampleRate", context.sampleRate());
            } catch (Exception error) {
                response.addProperty("microphoneReady", false);
                response.addProperty("microphoneError", error.getMessage());
            }
            respond(exchange, 200, response);
            return;
        }
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 GET 或 POST"));
            return;
        }
        try {
            String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
            if (contentType != null && !contentType.isBlank()
                    && !contentType.toLowerCase(Locale.ROOT).startsWith("audio/wav")
                    && !contentType.toLowerCase(Locale.ROOT).startsWith("audio/x-wav")
                    && !contentType.toLowerCase(Locale.ROOT).startsWith("application/octet-stream")) {
                throw new IllegalArgumentException("语音必须是 WAV 音频");
            }
            PcmAudio audio = decodeWav(readBytes(exchange, MAX_AUDIO_BYTES));
            if (audio.samples().length == 0) throw new IllegalArgumentException("语音音频为空");
            String query = exchange.getRequestURI().getQuery();
            if (query != null && !Set.of("mode=local", "mode=microphone").contains(query)) throw new IllegalArgumentException("语音播放模式无效");
            boolean microphoneMode = "mode=microphone".equals(query);
            if (microphoneMode) {
                if (client.player == null || client.level == null) throw new IllegalStateException("Minecraft 尚未进入世界");
                PlasmoVoiceBridge.prepare(plasmoVoiceClient());
            }
            Object source = microphoneMode ? null : ensureVoiceSource();
            if (!queuedVoiceTasks.compareAndSet(0, 1)) {
                respond(exchange, 429, error("已有语音正在发送，请稍后重试"));
                return;
            }
            voiceTaskState = "sending";
            voiceTaskMode = microphoneMode ? "microphone" : "local";
            voiceTaskError = null;
            voiceFramesSent = 0;
            voiceTaskUpdatedAt = Instant.now().toString();
            var task = voiceExecutor.submit(() -> {
                try {
                    if (microphoneMode) voiceFramesSent = PlasmoVoiceBridge.send(PlasmoVoiceBridge.prepare(plasmoVoiceClient()), audio.samples(), VOICE_SAMPLE_RATE);
                    else playVoice(source, audio.samples());
                    voiceTaskState = "completed";
                    return true;
                } catch (Throwable error) {
                    voiceTaskState = "error";
                    voiceTaskError = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                    LOGGER.warn(microphoneMode ? "Minecraft AI microphone voice failed" : "Minecraft AI voice playback failed", error);
                    throw new IllegalStateException(voiceTaskError, error);
                } finally {
                    voiceTaskUpdatedAt = Instant.now().toString();
                    queuedVoiceTasks.decrementAndGet();
                }
            });
            try {
                task.get(MAX_AUDIO_SECONDS + 5, TimeUnit.SECONDS);
            } catch (Exception error) {
                task.cancel(true);
                throw new IllegalStateException(voiceTaskError == null ? "语音发送超时或已中断" : voiceTaskError, error);
            }
            JsonObject response = baseResponse();
            response.addProperty("voiceBridgeVersion", 2);
            response.addProperty("completed", true);
            response.addProperty("framesSent", voiceFramesSent);
            response.addProperty("mode", microphoneMode ? "microphone" : "local");
            response.addProperty("sampleRate", VOICE_SAMPLE_RATE);
            response.addProperty("durationMs", Math.round(audio.samples().length * 1000.0 / VOICE_SAMPLE_RATE));
            respond(exchange, 200, response);
        } catch (UnsupportedOperationException error) {
            respond(exchange, 503, error(error.getMessage()));
        } catch (Exception error) {
            respond(exchange, 400, error(error.getMessage() == null ? "语音请求无效" : error.getMessage()));
        }
    }

    private Object plasmoVoiceClient() throws Exception {
        Class<?> voiceClass;
        try {
            voiceClass = Class.forName("su.plo.voice.client.ModVoiceClient");
        } catch (ClassNotFoundException error) {
            throw new UnsupportedOperationException("未检测到 Plasmo Voice 语音模组", error);
        }
        Object voiceClient;
        try {
            voiceClient = voiceClass.getField("INSTANCE").get(null);
        } catch (NoSuchFieldException error) {
            throw new UnsupportedOperationException("当前 Plasmo Voice 版本不支持语音注入", error);
        }
        if (voiceClient == null) throw new UnsupportedOperationException("Plasmo Voice 尚未初始化");
        return voiceClient;
    }

    private Object ensureVoiceSource() throws Exception {
        Object existing = plasmoVoiceLoopback;
        if (existing != null && !Boolean.TRUE.equals(invoke(existing, "isClosed"))) return existing;
        CompletableFuture<Object> result = new CompletableFuture<>();
        client.execute(() -> {
            try {
                Object voiceClient = plasmoVoiceClient();
                Object sourceManager = invoke(voiceClient, "getSourceManager");
                Object source = invoke(sourceManager, "createLoopbackSource", new Class<?>[]{boolean.class}, true);
                invoke(source, "initialize", new Class<?>[]{boolean.class}, false);
                plasmoVoiceLoopback = source;
                result.complete(source);
            } catch (Throwable error) {
                if (error instanceof ClassNotFoundException || error instanceof NoSuchFieldException || error instanceof NoSuchMethodException) {
                    result.completeExceptionally(new UnsupportedOperationException("未检测到 Plasmo Voice 语音模组"));
                    return;
                }
                result.completeExceptionally(error);
            }
        });
        try {
            return result.get(5, TimeUnit.SECONDS);
        } catch (java.util.concurrent.ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof UnsupportedOperationException unsupported) throw unsupported;
            if (cause instanceof Exception exception) throw exception;
            throw new IllegalStateException(cause == null ? "Plasmo Voice 初始化失败" : cause.getMessage(), cause);
        }
    }

    private void closeVoiceSource() {
        Object source = plasmoVoiceLoopback;
        plasmoVoiceLoopback = null;
        if (source == null) return;
        try { invoke(source, "close"); } catch (Throwable error) { LOGGER.debug("Could not close Plasmo Voice loopback", error); }
    }

    private void playVoice(Object source, short[] samples) throws Exception {
        java.lang.reflect.Method write = source.getClass().getMethod("write", short[].class);
        for (int offset = 0; offset < samples.length; offset += 960) {
            int length = Math.min(960, samples.length - offset);
            short[] frame = new short[length];
            System.arraycopy(samples, offset, frame, 0, length);
            write.invoke(source, (Object) frame);
            if (offset + length < samples.length) Thread.sleep(Math.max(1L, Math.round(length * 1000.0 / VOICE_SAMPLE_RATE)));
        }
    }

    private Object invoke(Object target, String method, Class<?>[] parameterTypes, Object... arguments) throws Exception {
        try {
            return target.getClass().getMethod(method, parameterTypes).invoke(target, arguments);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception exception) throw exception;
            if (cause instanceof Error fatal) throw fatal;
            throw error;
        }
    }

    private Object invoke(Object target, String method) throws Exception {
        return invoke(target, method, new Class<?>[0]);
    }

    private byte[] readBytes(HttpExchange exchange, int maxBytes) throws IOException {
        try (InputStream input = exchange.getRequestBody()) {
            byte[] buffer = new byte[maxBytes + 1];
            int offset = 0;
            int read;
            while ((read = input.read(buffer, offset, buffer.length - offset)) != -1) {
                offset += read;
                if (offset > maxBytes) throw new IllegalArgumentException("音频文件不能超过 4 MB");
                if (offset == buffer.length) break;
            }
            byte[] result = new byte[offset];
            System.arraycopy(buffer, 0, result, 0, offset);
            return result;
        }
    }

    private PcmAudio decodeWav(byte[] bytes) {
        if (bytes.length < 44 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) {
            throw new IllegalArgumentException("只支持 PCM WAV 音频");
        }
        int cursor = 12;
        int format = -1;
        int channels = -1;
        int sampleRate = -1;
        int dataOffset = -1;
        int dataLength = -1;
        while (cursor + 8 <= bytes.length) {
            String chunk = new String(bytes, cursor, 4, StandardCharsets.US_ASCII);
            long declaredSize = littleUnsignedInt(bytes, cursor + 4);
            if (declaredSize > Integer.MAX_VALUE) throw new IllegalArgumentException("WAV 区块过大");
            int size = (int) declaredSize;
            int content = cursor + 8;
            if (content > bytes.length || size > bytes.length - content) throw new IllegalArgumentException("WAV 文件损坏");
            if ("fmt ".equals(chunk) && size >= 16) {
                format = littleUnsignedShort(bytes, content);
                channels = littleUnsignedShort(bytes, content + 2);
                sampleRate = (int) littleUnsignedInt(bytes, content + 4);
                int bits = littleUnsignedShort(bytes, content + 14);
                if (format != 1 || bits != 16 || (channels != 1 && channels != 2)) {
                    throw new IllegalArgumentException("WAV 必须是 16 位单声道或双声道 PCM");
                }
            } else if ("data".equals(chunk)) {
                dataOffset = content;
                dataLength = size;
                break;
            }
            cursor = content + size + (size & 1);
        }
        if (format < 0 || dataOffset < 0 || sampleRate < 8_000 || sampleRate > 96_000) {
            throw new IllegalArgumentException("WAV 缺少有效的 PCM 音频数据");
        }
        int frameBytes = channels * 2;
        int frames = dataLength / frameBytes;
        if (frames <= 0 || frames > sampleRate * MAX_AUDIO_SECONDS) throw new IllegalArgumentException("语音时长不能超过 30 秒");
        int outputFrames = Math.max(1, (int) Math.ceil(frames * (double) VOICE_SAMPLE_RATE / sampleRate));
        short[] output = new short[outputFrames];
        for (int index = 0; index < outputFrames; index++) {
            double sourcePosition = index * (double) sampleRate / VOICE_SAMPLE_RATE;
            int first = Math.min(frames - 1, (int) sourcePosition);
            int second = Math.min(frames - 1, first + 1);
            double fraction = sourcePosition - first;
            double firstSample = frameSample(bytes, dataOffset, first, channels);
            double secondSample = frameSample(bytes, dataOffset, second, channels);
            output[index] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(firstSample + (secondSample - firstSample) * fraction)));
        }
        return new PcmAudio(output);
    }

    private double frameSample(byte[] bytes, int offset, int frame, int channels) {
        int base = offset + frame * channels * 2;
        int left = littleSignedShort(bytes, base);
        if (channels == 1) return left;
        return (left + littleSignedShort(bytes, base + 2)) / 2.0;
    }

    private boolean ascii(byte[] bytes, int offset, String value) {
        if (offset < 0 || offset + value.length() > bytes.length) return false;
        for (int index = 0; index < value.length(); index++) if (bytes[offset + index] != (byte) value.charAt(index)) return false;
        return true;
    }

    private long littleUnsignedInt(byte[] bytes, int offset) {
        return (bytes[offset] & 0xffL) | ((bytes[offset + 1] & 0xffL) << 8)
                | ((bytes[offset + 2] & 0xffL) << 16) | ((bytes[offset + 3] & 0xffL) << 24);
    }

    private int littleUnsignedShort(byte[] bytes, int offset) {
        return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
    }

    private short littleSignedShort(byte[] bytes, int offset) {
        return (short) littleUnsignedShort(bytes, offset);
    }

    private record PcmAudio(short[] samples) {}

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
                result.complete(inventoryResponse());
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

    private JsonObject inventoryItemJson(int slot) {
        var inventory = client.player.getInventory();
        var stack = inventory.getItem(slot);
        JsonObject item = new JsonObject();
        item.addProperty("slot", slot);
        item.addProperty("itemId", stack.getItem().builtInRegistryHolder().getRegisteredName());
        item.addProperty("name", stack.getHoverName().getString());
        item.addProperty("count", stack.getCount());
        item.addProperty("selected", slot == inventory.getSelectedSlot());
        item.addProperty("damage", stack.getDamageValue());
        item.addProperty("maxDamage", stack.getMaxDamage());
        item.addProperty("broken", stack.isBroken());
        return item;
    }

    private JsonObject inventoryResponse() {
        if (client.player == null || client.level == null) throw new IllegalStateException("Minecraft 尚未进入世界");
        var inventory = client.player.getInventory();
        JsonArray items = new JsonArray();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            if (!inventory.getItem(slot).isEmpty()) items.add(inventoryItemJson(slot));
        }
        JsonObject response = baseResponse();
        response.addProperty("player", client.player.getName().getString());
        response.addProperty("selectedSlot", inventory.getSelectedSlot());
        response.addProperty("slotCount", inventory.getContainerSize());
        response.addProperty("miningToolSelection", "pickaxe_priority_v1");
        response.add("items", items);
        return response;
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

    // All player discovery, target validation and task mutations run on the game thread.
    private void followRequest(HttpExchange exchange, String method, java.util.concurrent.Callable<JsonObject> action) throws IOException {
        if (!method.equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 " + method));
            return;
        }
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            if (result.isDone()) return;
            try { result.complete(action.call()); }
            catch (Throwable failure) { result.completeExceptionally(failure); }
        });
        try { respond(exchange, 200, result.get(5, TimeUnit.SECONDS)); }
        catch (java.util.concurrent.TimeoutException failure) {
            result.cancel(false);
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception failure) {
            Throwable cause = failure.getCause() == null ? failure : failure.getCause();
            respond(exchange, 400, error(cause.getMessage() == null ? "跟随请求失败" : cause.getMessage()));
        }
    }

    private void requireFollowWorld() {
        if (client.player == null || client.level == null || client.gameMode == null) throw new IllegalStateException("Minecraft 尚未进入可操作的世界");
    }

    private List<Player> nearbyPlayers() {
        requireFollowWorld();
        return client.level.players().stream()
            .filter(player -> player != client.player && player.isAlive() && !player.isSpectator()
                && player.distanceToSqr(client.player) <= PLAYER_SCAN_RADIUS * PLAYER_SCAN_RADIUS)
            .sorted(Comparator.comparingDouble((Player player) -> player.distanceToSqr(client.player))
                .thenComparing(player -> player.getUUID().toString()))
            .map(player -> (Player) player).toList();
    }

    private JsonObject nearbyPlayerJson(Player player) {
        JsonObject json = new JsonObject();
        json.addProperty("uuid", player.getUUID().toString());
        json.addProperty("name", player.getGameProfile().name());
        json.addProperty("distance", Math.sqrt(player.distanceToSqr(client.player)));
        json.addProperty("x", player.getX());
        json.addProperty("y", player.getY());
        json.addProperty("z", player.getZ());
        return json;
    }

    private void handlePlayers(HttpExchange exchange) throws IOException {
        followRequest(exchange, "GET", () -> {
            JsonObject response = baseResponse();
            response.addProperty("radius", PLAYER_SCAN_RADIUS);
            JsonArray players = new JsonArray();
            for (Player player : nearbyPlayers()) players.add(nearbyPlayerJson(player));
            response.add("players", players);
            return response;
        });
    }

    private void handleFollowStart(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        final FollowPlan plan;
        try { plan = parseFollowPlan(JsonParser.parseString(readBody(exchange)).getAsJsonObject()); }
        catch (Exception failure) { respond(exchange, 400, error(failure.getMessage() == null ? "跟随参数无效" : failure.getMessage())); return; }
        followRequest(exchange, "POST", () -> {
            requireFollowWorld();
            requireNoAtomicTask();
            if (miningTask != null && miningTask.isActive()) throw new IllegalStateException("正在挖矿，请先停止挖矿再开始跟随");
            if (followTask != null && followTask.isActive()) throw new IllegalStateException("已有跟随任务，请先停止后再选择玩家");
            String unsafe = followSafetyReason();
            if (unsafe != null) throw new IllegalStateException(unsafe);
            Player chosen = nearbyPlayers().stream()
                .filter(player -> (plan.targetUuid == null || player.getUUID().equals(plan.targetUuid))
                    && (plan.targetName == null || player.getGameProfile().name().equalsIgnoreCase(plan.targetName)))
                .findFirst().orElseThrow(() -> new IllegalStateException("32 格内没有符合条件的其他玩家"));
            stopFollowTicker();
            followTask = new FollowTask(plan, chosen, client.level, client.player.position());
            followTask.ignoreSafety = plan.ignoreSafety() || followIgnoreSafetyDefault;
            tickFollowing();
            if (followTask.isActive()) {
                FollowTask scheduledTask = followTask;
                AtomicBoolean pending = new AtomicBoolean();
                followTicker = miningExecutor.scheduleAtFixedRate(() -> {
                    // Do not accumulate movement callbacks while the client thread is paused or busy.
                    if (!pending.compareAndSet(false, true)) return;
                    client.execute(() -> {
                        try { if (followTask == scheduledTask) tickFollowing(); }
                        finally { pending.set(false); }
                    });
                }, 100, 100, TimeUnit.MILLISECONDS);
            }
            return followStatusResponse();
        });
    }

    private void handleFollowStatus(HttpExchange exchange) throws IOException {
        followRequest(exchange, "GET", this::followStatusResponse);
    }

    private void handleFollowStop(HttpExchange exchange) throws IOException {
        followRequest(exchange, "POST", () -> {
            if (followTask != null && followTask.isActive()) followTask.finish("stopped", "已停止跟随");
            stopFollowTicker();
            return followStatusResponse();
        });
    }

    private FollowPlan parseFollowPlan(JsonObject body) {
        UUID targetUuid = null;
        String targetName = null;
        if (body.has("targetUuid")) {
            var value = body.get("targetUuid");
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                || !value.getAsString().matches("(?i)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")) throw new IllegalArgumentException("玩家 UUID 无效");
            targetUuid = UUID.fromString(value.getAsString());
        }
        if (body.has("targetName")) {
            var value = body.get("targetName");
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                || !value.getAsString().matches("[\\p{L}\\p{N}_.-]{1,64}")) throw new IllegalArgumentException("玩家名称无效");
            targetName = value.getAsString();
        }
        for (String field : List.of("followDistance", "maxMinutes")) {
            if (body.has(field) && (!body.get(field).isJsonPrimitive() || !body.getAsJsonPrimitive(field).isNumber())) throw new IllegalArgumentException(field + " 必须是数字");
        }
        boolean ignoreSafety = false;
        if (body.has("ignoreSafety")) {
            if (!body.get("ignoreSafety").isJsonPrimitive() || !body.getAsJsonPrimitive("ignoreSafety").isBoolean()) throw new IllegalArgumentException("ignoreSafety 必须是布尔值");
            ignoreSafety = body.get("ignoreSafety").getAsBoolean();
        }
        return new FollowPlan(targetUuid, targetName, numberField(body, "followDistance", 2, 6, 3), numberField(body, "maxMinutes", 0.01, 30, 10), ignoreSafety);
    }

    private void handleFollowSafety(HttpExchange exchange) throws IOException {
        final boolean ignoreSafety;
        try {
            JsonObject body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
            if (!body.has("ignoreSafety") || !body.get("ignoreSafety").isJsonPrimitive() || !body.getAsJsonPrimitive("ignoreSafety").isBoolean()) {
                throw new IllegalArgumentException("ignoreSafety 必须是布尔值");
            }
            ignoreSafety = body.get("ignoreSafety").getAsBoolean();
        } catch (Exception failure) {
            respond(exchange, 400, error(failure.getMessage() == null ? "安全模式参数无效" : failure.getMessage()));
            return;
        }
        followRequest(exchange, "POST", () -> {
            followIgnoreSafetyDefault = ignoreSafety;
            if (followTask == null) return followStatusResponse();
            followTask.ignoreSafety = ignoreSafety;
            followTask.waypoints.clear();
            followTask.nextRepathAt = 0;
            followTask.noPathSince = 0;
            followTask.message = followTask.ignoreSafety ? "已切换为无视周围安全的行走模式" : "已恢复安全行走模式";
            return followStatusResponse();
        });
    }

    private String followSafetyReason() {
        if (!client.player.isAlive() || client.player.getHealth() <= 6) return "生命值过低，无法安全跟随";
        if (client.player.isSpectator()) return "旁观模式不能跟随";
        if (client.player.getFoodData().getFoodLevel() <= 6) return "饥饿值过低，无法安全跟随";
        if (client.player.isInLava() || client.player.isInWater()) return "进入液体，已停止跟随";
        if (client.player.isPassenger() || client.player.getAbilities().flying) return "跟随仅支持地面步行，请先下坐骑或结束飞行";
        return null;
    }

    private void tickFollowing() {
        FollowTask task = followTask;
        if (task == null || !task.isActive()) return;
        try {
            if (client.player == null || client.level != task.level || client.gameMode == null) {
                finishFollowing("stopped", "已离开原世界，跟随停止"); return;
            }
            if (System.currentTimeMillis() - task.startedAt >= task.plan.maxMinutes * 60_000) {
                finishFollowing("timeout", "达到最大跟随时间"); return;
            }
            String unsafe = followSafetyReason();
            if (unsafe != null) { finishFollowing("safety_stop", unsafe); return; }
            Player target = client.level.players().stream().filter(player -> player.getUUID().equals(task.targetUuid)
                && player != client.player && player.isAlive() && !player.isSpectator()).findFirst().orElse(null);
            if (target == null || target.distanceToSqr(client.player) > 64 * 64) {
                finishFollowing("target_lost", "目标已离线、离开加载范围或超过 64 格，跟随停止"); return;
            }
            task.distance = Math.sqrt(target.distanceToSqr(client.player));
            if (client.isPaused() || client.gui.screen() != null) {
                releaseFollowInput(); task.state = "paused"; task.message = "等待关闭界面或恢复游戏后继续跟随 " + task.targetName;
                task.lastPosition = client.player.position(); task.stalledTicks = 0;
                task.waypoints.clear(); task.nextRepathAt = 0; task.noPathSince = 0; return;
            }
            boolean grounded = client.player.onGround();
            if (grounded && FollowPathfinder.withinFollowDistance(client.player.getX(), client.player.getY(), client.player.getZ(),
                target.getX(), target.getY(), target.getZ(), task.plan.followDistance)) {
                releaseFollowInput(); task.state = "holding"; task.message = "已靠近 " + task.targetName + "，正在保持距离";
                task.navigation = "holding"; task.waypoints.clear(); task.nextRepathAt = 0; task.noPathSince = 0;
                task.stalledTicks = 0; task.lastPosition = client.player.position(); return;
            }
            if (task.state.equals("following") && client.player.position().distanceToSqr(task.lastPosition) < 0.0025) task.stalledTicks++;
            else task.stalledTicks = 0;
            task.lastPosition = client.player.position();
            if (task.stalledTicks >= 50) { finishFollowing("stuck", "连续 5 秒无法移动，跟随停止"); return; }
            while (grounded && !task.waypoints.isEmpty()) {
                var point = task.waypoints.peek();
                if (Math.hypot(point.centerX() - client.player.getX(), point.centerZ() - client.player.getZ()) > 0.22
                    || Math.abs(point.y() - client.player.getY()) > 0.25) break;
                task.waypoints.remove();
            }
            long now = System.currentTimeMillis();
            if (grounded && (task.waypoints.isEmpty() || now >= task.nextRepathAt || task.stalledTicks >= 10)) {
                if (now >= task.nextRepathAt || !task.waypoints.isEmpty()) {
                    var terrain = new FollowTerrain(task.ignoreSafety);
                    var start = new FollowPathfinder.Point(client.player.blockPosition().getX(), client.player.getY(), client.player.blockPosition().getZ());
                    var route = FollowPathfinder.find(terrain, start, target.getX(), target.getY(), target.getZ(), task.plan.followDistance);
                    task.waypoints.clear();
                    task.waypoints.addAll(route.steps());
                    if (task.waypoints.isEmpty() && route.reachesTarget()) task.waypoints.add(start);
                    task.nextRepathAt = now + 750;
                }
            }
            if (task.waypoints.isEmpty()) {
                releaseFollowInput();
                task.navigation = "searching"; task.state = "pathfinding";
                task.message = "正在为跟随 " + task.targetName + " 寻找可通行路线";
                if (task.noPathSince == 0) task.noPathSince = now;
                if (now - task.noPathSince >= 5000) finishFollowing("stuck", "附近没有可通行路线（一格跳跃、落差小于四格），跟随停止");
                return;
            }
            var next = task.waypoints.peek();
            if (grounded && !new FollowTerrain(task.ignoreSafety).canMove(client.player.getX(), client.player.getY(), client.player.getZ(), next.centerX(), next.y(), next.centerZ())) {
                releaseFollowInput(); task.waypoints.clear(); task.nextRepathAt = 0;
                task.state = "pathfinding"; task.navigation = "searching"; task.message = "路线已受阻，正在重新寻找绕行路线";
                if (task.noPathSince == 0) task.noPathSince = now;
                if (now - task.noPathSince >= 5000) finishFollowing("stuck", "无法通过前方地形，跟随停止");
                return;
            }
            task.noPathSince = 0;
            double dx = next.centerX() - client.player.getX();
            double dz = next.centerZ() - client.player.getZ();
            double horizontal = Math.hypot(dx, dz);
            boolean jump = grounded && next.y() - client.player.getY() > 0.6 && horizontal <= 1.35;
            client.player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
            client.options.keyJump.setDown(jump);
            client.options.keyUp.setDown(horizontal > 0.12);
            task.state = "following";
            task.navigation = jump ? "jumping" : next.y() < client.player.getY() - 0.6 ? "dropping" : "walking";
            task.message = "正在跟随 " + task.targetName;
        } catch (Throwable failure) {
            LOGGER.warn("Minecraft AI following failed", failure);
            finishFollowing("error", failure.getMessage() == null ? "跟随执行异常" : failure.getMessage());
        }
    }

    /** Uses real collision shapes, including slabs/stairs, rather than full-block support faces. */
    private final class FollowTerrain implements FollowPathfinder.Terrain {
        private final Map<FollowPathfinder.Point, List<Double>> heights = new HashMap<>();
        private final boolean ignoreSafety;

        private FollowTerrain(boolean ignoreSafety) { this.ignoreSafety = ignoreSafety; }

        private AABB body(double x, double y, double z) {
            double radius = client.player.getBbWidth() / 2.0 - 0.001;
            return new AABB(x - radius, y + 0.001, z - radius, x + radius, y + client.player.getBbHeight(), z + radius);
        }

        private boolean clear(AABB box) {
            for (int x = (int) Math.floor(box.minX); x <= (int) Math.floor(box.maxX); x++) {
                for (int z = (int) Math.floor(box.minZ); z <= (int) Math.floor(box.maxZ); z++) {
                    for (int y = (int) Math.floor(box.minY - 0.02); y <= (int) Math.floor(box.maxY - 0.001); y++) {
                        BlockPos pos = new BlockPos(x, y, z);
                        if (!client.level.isLoaded(pos)) return false;
                        var state = client.level.getBlockState(pos);
                        if (!ignoreSafety && (!state.getFluidState().isEmpty() || FOLLOW_HAZARDS.contains(state.getBlock().builtInRegistryHolder().getRegisteredName()))) return false;
                    }
                }
            }
            return client.level.noCollision(client.player, box);
        }

        private boolean standable(double x, double y, double z) {
            var box = body(x, y, z);
            return clear(box) && !client.level.noCollision(client.player, box.move(0, -0.05, 0));
        }

        @Override
        public List<Double> standingHeights(int x, int z, double minY, double maxY) {
            var key = new FollowPathfinder.Point(x, maxY, z);
            return heights.computeIfAbsent(key, unused -> {
                Set<Double> candidates = new HashSet<>();
                for (int y = (int) Math.floor(minY) - 1; y <= (int) Math.floor(maxY); y++) {
                    BlockPos pos = new BlockPos(x, y, z);
                    if (!client.level.isLoaded(pos)) continue;
                    for (var shape : client.level.getBlockState(pos).getCollisionShape(client.level, pos).toAabbs()) {
                        double top = y + shape.maxY;
                        if (top < minY - 0.0001 || top > maxY + 0.0001) continue;
                        if (standable(x + 0.5, top, z + 0.5)) candidates.add(top);
                    }
                }
                List<Double> result = new ArrayList<>(candidates);
                result.sort(Comparator.comparingDouble(value -> Math.abs(value - (maxY - FollowPathfinder.MAX_RISE))));
                return List.copyOf(result);
            });
        }

        @Override
        public boolean canTraverse(FollowPathfinder.Point from, FollowPathfinder.Point to) {
            return canMove(from.centerX(), from.y(), from.centerZ(), to.centerX(), to.y(), to.centerZ());
        }

        @Override
        public boolean allowHeightChange(double fromY, double toY) {
            double rise = toY - fromY;
            return Double.isFinite(rise) && rise <= FollowPathfinder.MAX_RISE + FollowPathfinder.EPSILON
                && (ignoreSafety ? rise > -16.0 : rise > -FollowPathfinder.MAX_DROP + FollowPathfinder.EPSILON);
        }

        @Override
        public double maxDrop() { return ignoreSafety ? 16.0 : FollowPathfinder.MAX_DROP; }

        private boolean canMove(double fromX, double fromY, double fromZ, double toX, double toY, double toZ) {
            if (!allowHeightChange(fromY, toY) || !standable(toX, toY, toZ)) return false;
            boolean jumping = toY - fromY > 0.6;
            double top = jumping ? fromY + 1.25 : Math.max(fromY, toY);
            // Check ascent, horizontal travel, and the landing column separately. A drop
            // need not have support at the source height; it only needs a clear landing.
            return clear(body(fromX, fromY, fromZ).minmax(body(fromX, top, fromZ)))
                && clear(body(fromX, top, fromZ).expandTowards(toX - fromX, 0, toZ - fromZ))
                && clear(body(toX, toY, toZ).minmax(body(toX, top, toZ)));
        }
    }

    private void releaseFollowInput() {
        if (followTask == null || !followTask.ownsInput) return;
        client.options.keyUp.setDown(false);
        client.options.keyJump.setDown(false);
    }

    private void finishFollowing(String state, String message) {
        if (followTask != null) followTask.finish(state, message);
        stopFollowTicker();
    }

    private void stopFollowTicker() {
        releaseFollowInput();
        if (followTask != null) followTask.ownsInput = false;
        if (followTicker != null) { followTicker.cancel(false); followTicker = null; }
    }

    private JsonObject followStatusResponse() {
        JsonObject response = baseResponse();
        response.addProperty("status", followTask == null ? "idle" : followTask.state);
        response.addProperty("ignoreSafety", followTask == null ? followIgnoreSafetyDefault : followTask.ignoreSafety);
        if (followTask != null) response.add("follow", followTask.toJson());
        return response;
    }

    private void handleCraftRequest(HttpExchange exchange, String operation) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) { respond(exchange, 405, error("只支持 POST")); return; }
        final JsonObject body;
        try { body = JsonParser.parseString(readBody(exchange)).getAsJsonObject(); }
        catch (Exception failure) { respond(exchange, 400, error("合成请求必须是 JSON 对象")); return; }
        followRequest(exchange, "POST", () -> {
            if (operation.equals("recipes")) return crafting.query(body);
            if (operation.equals("stop")) {
                if (body.size() != 1 || !body.has("taskId") || !body.get("taskId").isJsonPrimitive() || !body.getAsJsonPrimitive("taskId").isString()) throw new IllegalArgumentException("必须提供合成操作 taskId");
                return crafting.cancel(body.get("taskId").getAsString());
            }
            requireAtomicWorld(); requireNoAtomicTask();
            if (miningTask != null && miningTask.isActive() || followTask != null && followTask.isActive()) throw new IllegalStateException("请先停止挖矿或跟随任务再合成");
            return crafting.start(body);
        });
    }

    private void handleOperationStop(HttpExchange exchange, boolean movement) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) { respond(exchange, 405, error("只支持 POST")); return; }
        final String taskId;
        try { taskId = JsonParser.parseString(readBody(exchange)).getAsJsonObject().get("taskId").getAsString(); }
        catch (Exception failure) { respond(exchange, 400, error("必须提供操作 taskId")); return; }
        followRequest(exchange, "POST", () -> {
            if (movement) {
                if (moveTask == null || !moveTask.id.equals(taskId)) throw new IllegalStateException("移动操作 ID 不匹配");
                finishMove("cancelled", "移动已取消"); return moveStatusResponse();
            }
            if (atomicTask == null || !atomicTask.id.equals(taskId)) throw new IllegalStateException("方块操作 ID 不匹配");
            finishAtomic("cancelled", "方块操作已取消"); return atomicStatusResponse();
        });
    }

    private void handleBlockScan(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        final JsonObject body;
        try { body = JsonParser.parseString(readBody(exchange)).getAsJsonObject(); }
        catch (Exception failure) { respond(exchange, 400, error("扫描参数无效")); return; }
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            if (result.isDone()) return;
            try { result.complete(scanBlocksResponse(body)); }
            catch (Throwable failure) { result.completeExceptionally(failure); }
        });
        respondOnFuture(exchange, result, "无法扫描方块");
    }

    private void handleBlockBreak(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        final JsonObject body;
        try { body = JsonParser.parseString(readBody(exchange)).getAsJsonObject(); }
        catch (Exception failure) { respond(exchange, 400, error("破坏方块参数无效")); return; }
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            if (result.isDone()) return;
            try { result.complete(breakBlockResponse(body)); }
            catch (Throwable failure) { result.completeExceptionally(failure); }
        });
        respondOnFuture(exchange, result, "无法破坏方块");
    }

    private void handleBlockPlace(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("只支持 POST"));
            return;
        }
        final JsonObject body;
        try { body = JsonParser.parseString(readBody(exchange)).getAsJsonObject(); }
        catch (Exception failure) { respond(exchange, 400, error("放置方块参数无效")); return; }
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        client.execute(() -> {
            if (result.isDone()) return;
            try { result.complete(placeBlockResponse(body)); }
            catch (Throwable failure) { result.completeExceptionally(failure); }
        });
        respondOnFuture(exchange, result, "无法放置方块");
    }

    private void respondOnFuture(HttpExchange exchange, CompletableFuture<JsonObject> result, String fallback) throws IOException {
        try {
            respond(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException failure) {
            result.cancel(false);
            respond(exchange, 504, error("Minecraft 客户端响应超时"));
        } catch (Exception failure) {
            Throwable cause = failure instanceof java.util.concurrent.ExecutionException && failure.getCause() != null
                ? failure.getCause() : failure;
            respond(exchange, 400, error(cause.getMessage() == null ? fallback : cause.getMessage()));
        }
    }

    private void requireAtomicWorld() {
        if (client.player == null || client.level == null || client.gameMode == null) throw new IllegalStateException("Minecraft 尚未进入世界");
    }

    private void requireNoAtomicTask() {
        if (crafting != null && crafting.isActive()) throw new IllegalStateException("合成任务正在运行，请先停止合成");
        if (atomicTask != null && atomicTask.active) throw new IllegalStateException("方块操作正在运行，请先停止");
        if (moveTask != null && moveTask.active) throw new IllegalStateException("移动任务正在运行，请先停止");
    }

    private void requireAtomicSafety() {
        requireAtomicWorld();
        if (client.player.isSpectator() || !client.player.isAlive()) throw new IllegalStateException("玩家当前不能执行方块操作");
        if (client.player.getHealth() <= 6.0F || client.player.getFoodData().getFoodLevel() <= 6) throw new IllegalStateException("玩家生命或饥饿值过低，已拒绝方块操作");
        if (client.player.isInLava() || client.player.isPassenger() || client.player.getAbilities().flying) throw new IllegalStateException("玩家当前处于不安全状态");
        requireMiningInventoryAccess();
        if (miningTask != null && miningTask.isActive()) throw new IllegalStateException("挖矿任务正在运行，请先停止任务");
        if (followTask != null && followTask.isActive()) throw new IllegalStateException("跟随任务正在运行，请先停止任务");
    }

    private BlockPos requestBlockPosition(JsonObject body) {
        if (body == null || !body.has("x") || !body.has("y") || !body.has("z")) throw new IllegalArgumentException("必须提供 x、y、z 坐标");
        if (!body.get("x").isJsonPrimitive() || !body.get("y").isJsonPrimitive() || !body.get("z").isJsonPrimitive()
            || !body.getAsJsonPrimitive("x").isNumber() || !body.getAsJsonPrimitive("y").isNumber() || !body.getAsJsonPrimitive("z").isNumber()) {
            throw new IllegalArgumentException("x、y、z 必须是数字");
        }
        double x = body.get("x").getAsDouble();
        double y = body.get("y").getAsDouble();
        double z = body.get("z").getAsDouble();
        if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)
            || x != Math.rint(x) || y != Math.rint(y) || z != Math.rint(z)) throw new IllegalArgumentException("x、y、z 必须是整数");
        if (x < -30_000_000 || x > 30_000_000 || z < -30_000_000 || z > 30_000_000 || y < -64 || y > 320) {
            throw new IllegalArgumentException("坐标超出允许范围");
        }
        return new BlockPos((int) x, (int) y, (int) z);
    }

    private void requireBlockDistance(BlockPos pos, double maxDistance) {
        double distance = Math.sqrt(client.player.distanceToSqr(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5));
        if (!Double.isFinite(distance) || distance > maxDistance) throw new IllegalArgumentException("目标方块距离过远，最大允许距离为 " + maxDistance + " 格");
    }

    private JsonObject blockPositionJsonWithDistance(BlockPos pos) {
        JsonObject json = MiningTask.blockPositionJson(pos);
        json.addProperty("distance", Math.sqrt(client.player.distanceToSqr(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5)));
        return json;
    }

    private JsonObject scanBlocksResponse(JsonObject body) {
        requireAtomicWorld();
        validateAtomicBody(body, Set.of("x", "y", "z", "radius", "maxResults", "blocks"), Set.of());
        for (String name : List.of("radius", "maxResults")) {
            if (body.has(name) && (!body.get(name).isJsonPrimitive() || !body.getAsJsonPrimitive(name).isNumber()
                || !Double.isFinite(body.get(name).getAsDouble()) || body.get(name).getAsDouble() != Math.rint(body.get(name).getAsDouble()))) throw new IllegalArgumentException(name + " 必须是整数");
        }
        int radius = integerField(body, "radius", 1, 16, 8);
        int maxResults = integerField(body, "maxResults", 1, 64, 32);
        if (body.has("radius") && (body.get("radius").getAsDouble() < 1 || body.get("radius").getAsDouble() > 16)
            || body.has("maxResults") && (body.get("maxResults").getAsDouble() < 1 || body.get("maxResults").getAsDouble() > 64)) throw new IllegalArgumentException("扫描范围或结果数量超限");
        Set<String> filters = new HashSet<>();
        if (body.has("blocks")) {
            if (!body.get("blocks").isJsonArray() || body.getAsJsonArray("blocks").size() < 1 || body.getAsJsonArray("blocks").size() > 16) throw new IllegalArgumentException("blocks 必须包含 1 到 16 个方块 ID");
            for (var item : body.getAsJsonArray("blocks")) {
                if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("blocks 只能包含字符串");
                String id = item.getAsString().trim().toLowerCase(Locale.ROOT);
                if (!id.matches("minecraft:[a-z0-9_./-]+")) throw new IllegalArgumentException("方块 ID 无效");
                filters.add(id);
            }
        }
        BlockPos center = body.has("x") || body.has("y") || body.has("z") ? requestBlockPosition(body) : client.player.blockPosition();
        requireBlockDistance(center, 32.0);
        JsonArray blocks = new JsonArray();
        List<BlockPos> candidates = new ArrayList<>();
        for (int y = -radius; y <= radius; y++) for (int x = -radius; x <= radius; x++) for (int z = -radius; z <= radius; z++) {
            BlockPos pos = center.offset(x, y, z);
            if (!client.level.isLoaded(pos)) continue;
            var state = client.level.getBlockState(pos);
            if (state.isAir()) continue;
            String id = state.getBlock().builtInRegistryHolder().getRegisteredName();
            if (!filters.isEmpty() && !filters.contains(id)) continue;
            candidates.add(pos);
        }
        candidates.sort(Comparator.comparingDouble(pos -> client.player.distanceToSqr(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5)));
        for (BlockPos pos : candidates) {
            if (blocks.size() >= maxResults) break;
            JsonObject item = blockPositionJsonWithDistance(pos);
            item.addProperty("blockId", client.level.getBlockState(pos).getBlock().builtInRegistryHolder().getRegisteredName());
            item.addProperty("loaded", true);
            item.addProperty("visible", visibleHit(pos) != null);
            item.addProperty("inReach", client.player.getEyePosition().distanceToSqr(Vec3.atCenterOf(pos)) <= 4.5 * 4.5);
            blocks.add(item);
        }
        JsonObject response = baseResponse();
        response.add("center", MiningTask.blockPositionJson(center));
        response.addProperty("radius", radius);
        response.addProperty("dimension", client.level.dimension().identifier().toString());
        response.addProperty("maxResults", maxResults);
        response.add("blocks", blocks);
        response.addProperty("matchedCount", candidates.size());
        response.addProperty("truncated", candidates.size() > maxResults);
        return response;
    }

    private void requireAtomicActionAvailable() {
        requireAtomicSafety();
        requireNoAtomicTask();
        if (client.isPaused() || client.gui.screen() != null) throw new IllegalStateException("游戏已暂停或界面打开，无法执行方块操作");
    }

    private JsonObject breakBlockResponse(JsonObject body) {
        requireAtomicActionAvailable();
        validateAtomicBody(body, Set.of("x", "y", "z", "dimension", "expectedBlockId"), Set.of("x", "y", "z", "dimension", "expectedBlockId"));
        requireDimension(body);
        BlockPos pos = requestBlockPosition(body);
        requireInteractionReach(pos);
        if (!client.level.isLoaded(pos)) throw new IllegalStateException("目标区块尚未加载");
        var state = client.level.getBlockState(pos);
        String blockId = state.getBlock().builtInRegistryHolder().getRegisteredName();
        if (state.isAir()) throw new IllegalStateException("目标位置是空气");
        if (!body.has("expectedBlockId") || !blockId.equals(body.get("expectedBlockId").getAsString())) throw new IllegalStateException("目标方块已变化，请重新扫描");
        if (state.getDestroySpeed(client.level, pos) < 0) throw new IllegalStateException("目标方块不可破坏");
        if (pos.getY() < client.player.getY() && Math.abs(pos.getX() + 0.5 - client.player.getX()) < 1
            && Math.abs(pos.getZ() + 0.5 - client.player.getZ()) < 1) throw new IllegalStateException("禁止挖掘脚下支撑方块");
        BlockHitResult hit = visibleHit(pos);
        if (hit == null) throw new IllegalStateException("目标方块被遮挡");
        // Select the best compatible tool using real inventory swaps, never local stack mutation.
        var inventory = client.player.getInventory();
        int chosen = inventory.getSelectedSlot();
        double speed = -1;
        for (int slot = 0; slot < 36; slot++) {
            var stack = inventory.getItem(slot);
            if (stack.isBroken() || !stack.canDestroyBlock(state, client.level, pos, client.player)
                || (state.requiresCorrectToolForDrops() && !stack.isCorrectToolForDrops(state))) continue;
            double candidate = stack.getDestroySpeed(state);
            if (candidate > speed) { speed = candidate; chosen = slot; }
        }
        if (speed < 0) throw new IllegalStateException("背包中没有能正确采集目标的工具");
        equipAtomicSlot(chosen);
        atomicTask = new AtomicTask("break", pos, blockId, client.level);
        atomicTask.selectedItem = inventoryItemJson(client.player.getInventory().getSelectedSlot());
        scheduleAtomic();
        return atomicStatusResponse();
    }

    private void requireDimension(JsonObject body) {
        if (!body.has("dimension") || !client.level.dimension().identifier().toString().equals(body.get("dimension").getAsString())) {
            throw new IllegalArgumentException("维度不匹配，请重新观察后提供 dimension");
        }
    }

    private void validateAtomicBody(JsonObject body, Set<String> allowed, Set<String> required) {
        for (String key : body.keySet()) if (!allowed.contains(key)) throw new IllegalArgumentException("不支持的参数：" + key);
        for (String key : required) if (!body.has(key)) throw new IllegalArgumentException("缺少参数：" + key);
        for (String key : List.of("dimension", "expectedBlockId", "itemId", "face")) {
            if (body.has(key) && (!body.get(key).isJsonPrimitive() || !body.getAsJsonPrimitive(key).isString()
                || body.get(key).getAsString().length() > 128)) throw new IllegalArgumentException(key + " 必须是有效字符串");
        }
        if (body.has("distance") && (!body.get("distance").isJsonPrimitive() || !body.getAsJsonPrimitive("distance").isNumber())) throw new IllegalArgumentException("distance 必须是数字");
    }

    private void requireInteractionReach(BlockPos pos) {
        if (client.player.getEyePosition().distanceToSqr(Vec3.atCenterOf(pos)) > 4.5 * 4.5) throw new IllegalStateException("方块超出 4.5 格交互距离");
    }

    private BlockHitResult visibleHit(BlockPos pos) {
        Vec3 eye = client.player.getEyePosition();
        Vec3 center = Vec3.atCenterOf(pos);
        // Test exposed faces; a center-only ray incorrectly rejects partially exposed blocks.
        for (Direction direction : Direction.values()) {
            Vec3 aim = center.add(direction.getStepX() * 0.499, direction.getStepY() * 0.499, direction.getStepZ() * 0.499);
            var hit = client.level.clip(new net.minecraft.world.level.ClipContext(eye, aim,
                net.minecraft.world.level.ClipContext.Block.OUTLINE, net.minecraft.world.level.ClipContext.Fluid.NONE, client.player));
            if (hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK && hit.getBlockPos().equals(pos)) return hit;
        }
        return null;
    }

    private int equipAtomicSlot(int slot) {
        var inventory = client.player.getInventory();
        if (slot >= 9) {
            var source = client.player.inventoryMenu.findSlot(inventory, slot);
            if (source.isEmpty()) throw new IllegalStateException("无法定位物品槽位");
            String id = inventory.getItem(slot).getItem().builtInRegistryHolder().getRegisteredName();
            int destination = inventory.getSelectedSlot();
            client.gameMode.handleContainerInput(client.player.inventoryMenu.containerId, source.getAsInt(), destination, ContainerInput.SWAP, client.player);
            if (!id.equals(inventory.getItem(destination).getItem().builtInRegistryHolder().getRegisteredName())) throw new IllegalStateException("物品交换失败");
            slot = destination;
        }
        inventory.setSelectedSlot(slot);
        client.player.connection.send(new ServerboundSetCarriedItemPacket(slot));
        return slot;
    }

    private void scheduleAtomic() {
        AtomicTask scheduled = atomicTask;
        AtomicBoolean pending = new AtomicBoolean();
        if (atomicTicker != null) atomicTicker.cancel(false);
        atomicTicker = miningExecutor.scheduleAtFixedRate(() -> {
            if (!pending.compareAndSet(false, true)) return;
            client.execute(() -> {
                try { if (atomicTask == scheduled) tickAtomic(); }
                finally { pending.set(false); }
            });
        }, 50, 50, TimeUnit.MILLISECONDS);
    }

    private void tickAtomic() {
        AtomicTask task = atomicTask;
        if (task == null || !task.active) return;
        try {
            requireAtomicSafety();
            if (client.level != task.level || client.isPaused() || client.gui.screen() != null) throw new IllegalStateException("世界已切换或游戏界面打开");
            requireInteractionReach(task.position);
            long elapsed = System.currentTimeMillis() - task.startedAt;
            if (elapsed > 20_000) { finishAtomic("timeout", "方块操作超时"); return; }
            var state = client.level.getBlockState(task.position);
            String current = state.getBlock().builtInRegistryHolder().getRegisteredName();
            if (task.kind.equals("break") && !current.equals(task.before)) {
                if (!state.isAir()) throw new IllegalStateException("挖掘目标被替换，请重新扫描");
                if (task.changedAt == 0) task.changedAt = System.currentTimeMillis();
                if (System.currentTimeMillis() - task.changedAt >= 350) finishAtomic("completed", "客户端已读回目标方块消失");
                return;
            }
            if (task.kind.equals("place")) {
                if (task.sent && current.equals(task.expected)) {
                    if (task.changedAt == 0) task.changedAt = System.currentTimeMillis();
                    if (System.currentTimeMillis() - task.changedAt >= 350) finishAtomic("completed", "客户端已读回放置结果");
                } else if (task.sent) {
                    task.changedAt = 0;
                    if (elapsed > 2500) finishAtomic("error", "放置后未读回预期方块");
                }
                else if (!task.sent && elapsed >= 350) {
                    if (!current.equals(task.before)) throw new IllegalStateException("放置目标已变化");
                    if (!client.player.getMainHandItem().getItem().builtInRegistryHolder().getRegisteredName().equals(task.itemId)) throw new IllegalStateException("手持物品已变化");
                    BlockPos support = task.position.relative(task.face.getOpposite());
                    Vec3 faceCenter = Vec3.atCenterOf(support).add(task.face.getStepX() * 0.5, task.face.getStepY() * 0.5, task.face.getStepZ() * 0.5);
                    // End the visibility ray slightly inside the support shape. At the
                    // exact face plane Minecraft may classify the endpoint as a miss.
                    Vec3 rayEnd = Vec3.atCenterOf(support).add(task.face.getStepX() * 0.499, task.face.getStepY() * 0.499, task.face.getStepZ() * 0.499);
                    var hit = client.level.clip(new net.minecraft.world.level.ClipContext(client.player.getEyePosition(), rayEnd,
                        net.minecraft.world.level.ClipContext.Block.OUTLINE, net.minecraft.world.level.ClipContext.Fluid.NONE, client.player));
                    if (hit.getType() != net.minecraft.world.phys.HitResult.Type.BLOCK || !hit.getBlockPos().equals(support) || hit.getDirection() != task.face) throw new IllegalStateException("放置面被遮挡");
                    if (!client.level.getBlockState(task.position).canBeReplaced()) throw new IllegalStateException("目标不可替换");
                    var interaction = client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, new BlockHitResult(faceCenter, task.face, support, false));
                    task.sent = true;
                    if (!interaction.consumesAction()) finishAtomic("error", "游戏拒绝放置方块");
                }
                return;
            }
            task.changedAt = 0;
            if (elapsed < 350) return;
            var held = client.player.getMainHandItem();
            if (held.isBroken() || !held.canDestroyBlock(state, client.level, task.position, client.player)
                || (state.requiresCorrectToolForDrops() && !held.isCorrectToolForDrops(state))) throw new IllegalStateException("工具已变化或损坏");
            BlockHitResult hit = visibleHit(task.position);
            if (hit == null) throw new IllegalStateException("挖掘目标被遮挡");
            if (!task.sent) client.gameMode.startDestroyBlock(task.position, hit.getDirection());
            else client.gameMode.continueDestroyBlock(task.position, hit.getDirection());
            task.sent = true;
            client.player.swing(InteractionHand.MAIN_HAND);
        } catch (Throwable failure) { finishAtomic("safety_stop", failure.getMessage()); }
    }

    private void finishAtomic(String state, String message) {
        if (atomicTask == null || !atomicTask.active) return;
        atomicTask.active = false;
        atomicTask.state = state;
        atomicTask.message = message;
        if (client.gameMode != null) client.gameMode.stopDestroyBlock();
        if (atomicTicker != null) { atomicTicker.cancel(false); atomicTicker = null; }
    }

    private JsonObject atomicStatusResponse() {
        JsonObject response = baseResponse();
        response.addProperty("status", atomicTask == null ? "idle" : atomicTask.state);
        if (atomicTask != null) response.add("action", atomicTask.toJson());
        return response;
    }

    private Direction parseDirection(JsonObject body) {
        String raw = body.has("face") ? body.get("face").getAsString().trim().toLowerCase(Locale.ROOT) : "up";
        return switch (raw) {
            case "up" -> Direction.UP;
            case "down" -> Direction.DOWN;
            case "north" -> Direction.NORTH;
            case "south" -> Direction.SOUTH;
            case "east" -> Direction.EAST;
            case "west" -> Direction.WEST;
            default -> throw new IllegalArgumentException("face 必须是 up、down、north、south、east 或 west");
        };
    }

    private int selectPlaceableItem(String requestedId) {
        var inventory = client.player.getInventory();
        int chosen = inventory.getSelectedSlot();
        if (requestedId != null && !requestedId.isBlank()) {
            if (!requestedId.matches("minecraft:[a-z0-9_./-]+")) throw new IllegalArgumentException("itemId 无效");
            chosen = -1;
            for (int slot = 0; slot < 36; slot++) {
                var stack = inventory.getItem(slot);
                if (!stack.isEmpty() && requestedId.equals(stack.getItem().builtInRegistryHolder().getRegisteredName())) { chosen = slot; break; }
            }
            if (chosen < 0) throw new IllegalStateException("背包中没有指定的放置物品");
        }
        var stack = inventory.getItem(chosen);
        if (stack.isEmpty() || !(stack.getItem() instanceof net.minecraft.world.item.BlockItem)) throw new IllegalStateException("主手没有可放置方块");
        return equipAtomicSlot(chosen);
    }

    private JsonObject placeBlockResponse(JsonObject body) {
        requireAtomicActionAvailable();
        validateAtomicBody(body, Set.of("x", "y", "z", "dimension", "itemId", "face"), Set.of("x", "y", "z", "dimension", "itemId"));
        requireDimension(body);
        BlockPos target = requestBlockPosition(body);
        requireInteractionReach(target);
        if (!client.level.isLoaded(target)) throw new IllegalStateException("目标区块尚未加载");
        Direction face = parseDirection(body);
        BlockPos support = target.relative(face.getOpposite());
        if (!client.level.getBlockState(target).canBeReplaced()) throw new IllegalStateException("目标位置已有不可替换方块");
        if (client.level.getBlockState(support).isAir()) throw new IllegalStateException("放置面没有相邻支撑方块");
        String requestedId = body.has("itemId") ? body.get("itemId").getAsString().trim().toLowerCase(Locale.ROOT) : null;
        int slot = selectPlaceableItem(requestedId);
        String itemId = client.player.getInventory().getItem(slot).getItem().builtInRegistryHolder().getRegisteredName();
        var blockItem = (net.minecraft.world.item.BlockItem) client.player.getMainHandItem().getItem();
        if (FOLLOW_HAZARDS.contains(blockItem.getBlock().builtInRegistryHolder().getRegisteredName())) throw new IllegalStateException("禁止自动放置危险方块");
        if (client.player.getBoundingBox().intersects(new AABB(target))) throw new IllegalStateException("禁止在玩家身体内放置方块");
        atomicTask = new AtomicTask("place", target, client.level.getBlockState(target).getBlock().builtInRegistryHolder().getRegisteredName(), client.level);
        atomicTask.face = face;
        atomicTask.itemId = itemId;
        atomicTask.expected = blockItem.getBlock().builtInRegistryHolder().getRegisteredName();
        atomicTask.selectedItem = inventoryItemJson(slot);
        scheduleAtomic();
        return atomicStatusResponse();
    }

    private void handleMoveStart(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) { respond(exchange, 405, error("只支持 POST")); return; }
        final JsonObject body;
        try { body = JsonParser.parseString(readBody(exchange)).getAsJsonObject(); }
        catch (Exception failure) { respond(exchange, 400, error("移动参数无效")); return; }
        followRequest(exchange, "POST", () -> {
            requireAtomicActionAvailable();
            validateAtomicBody(body, Set.of("x", "y", "z", "dimension", "distance"), Set.of("x", "y", "z", "dimension"));
            requireDimension(body);
            String unsafe = followSafetyReason();
            if (unsafe != null) throw new IllegalStateException(unsafe);
            BlockPos pos = requestBlockPosition(body);
            requireBlockDistance(pos, 32);
            if (!client.level.isLoaded(pos)) throw new IllegalStateException("目标区块尚未加载");
            moveTask = new MoveTask(pos, numberField(body, "distance", 0.5, 3, 1), client.level, client.player.position());
            AtomicBoolean pending = new AtomicBoolean();
            MoveTask scheduled = moveTask;
            if (moveTicker != null) moveTicker.cancel(false);
            moveTicker = miningExecutor.scheduleAtFixedRate(() -> {
                if (!pending.compareAndSet(false, true)) return;
                client.execute(() -> {
                    try { if (moveTask == scheduled) tickMove(); }
                    finally { pending.set(false); }
                });
            }, 100, 100, TimeUnit.MILLISECONDS);
            return moveStatusResponse();
        });
    }

    private void tickMove() {
        MoveTask task = moveTask;
        if (task == null || !task.active) return;
        try {
            requireAtomicSafety();
            if (client.level != task.level || client.isPaused() || client.gui.screen() != null) throw new IllegalStateException("世界已切换或游戏界面打开");
            String unsafe = followSafetyReason();
            if (unsafe != null) throw new IllegalStateException(unsafe);
            if (System.currentTimeMillis() - task.startedAt > 60_000) { finishMove("timeout", "移动超过 60 秒"); return; }
            double x = task.position.getX() + 0.5, y = task.position.getY(), z = task.position.getZ() + 0.5;
            boolean grounded = client.player.onGround();
            if (grounded && FollowPathfinder.withinFollowDistance(client.player.getX(), client.player.getY(), client.player.getZ(), x, y, z, task.distance)) {
                finishMove("completed", "已到达目标附近"); return;
            }
            if (task.state.equals("moving") && client.player.position().distanceToSqr(task.lastPosition) < 0.0025) task.stalledTicks++;
            else task.stalledTicks = 0;
            task.lastPosition = client.player.position();
            if (task.stalledTicks >= 50) { finishMove("stuck", "持续 5 秒无法移动"); return; }
            while (grounded && !task.waypoints.isEmpty()) {
                var point = task.waypoints.peek();
                if (Math.hypot(point.centerX() - client.player.getX(), point.centerZ() - client.player.getZ()) > 0.22 || Math.abs(point.y() - client.player.getY()) > 0.25) break;
                task.waypoints.remove();
            }
            long now = System.currentTimeMillis();
            if (grounded && (task.waypoints.isEmpty() || now >= task.nextRepathAt || task.stalledTicks >= 10) && now >= task.nextRepathAt) {
                var start = new FollowPathfinder.Point(client.player.blockPosition().getX(), client.player.getY(), client.player.blockPosition().getZ());
                var route = FollowPathfinder.find(new FollowTerrain(false), start, x, y, z, task.distance);
                task.waypoints.clear();
                task.waypoints.addAll(route.steps());
                task.nextRepathAt = now + 750;
            }
            if (task.waypoints.isEmpty()) {
                releaseMoveInput(); task.state = "pathfinding";
                if (task.noPathSince == 0) task.noPathSince = now;
                if (now - task.noPathSince >= 5000) finishMove("stuck", "没有安全可通行路线");
                return;
            }
            var next = task.waypoints.peek();
            if (grounded && !new FollowTerrain(false).canMove(client.player.getX(), client.player.getY(), client.player.getZ(), next.centerX(), next.y(), next.centerZ())) {
                releaseMoveInput(); task.waypoints.clear(); task.nextRepathAt = 0; task.state = "pathfinding";
                if (task.noPathSince == 0) task.noPathSince = now;
                if (now - task.noPathSince >= 5000) finishMove("stuck", "路线持续受阻");
                return;
            }
            task.noPathSince = 0;
            double dx = next.centerX() - client.player.getX(), dz = next.centerZ() - client.player.getZ();
            double horizontal = Math.hypot(dx, dz);
            client.player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
            client.options.keyJump.setDown(grounded && next.y() - client.player.getY() > 0.6 && horizontal <= 1.35);
            client.options.keyUp.setDown(horizontal > 0.12);
            task.state = "moving";
        } catch (Throwable failure) { finishMove("safety_stop", failure.getMessage()); }
    }

    private void releaseMoveInput() {
        client.options.keyUp.setDown(false);
        client.options.keyJump.setDown(false);
    }

    private void finishMove(String state, String message) {
        if (moveTask == null || !moveTask.active) return;
        moveTask.active = false; moveTask.state = state; moveTask.message = message;
        releaseMoveInput();
        if (moveTicker != null) { moveTicker.cancel(false); moveTicker = null; }
    }

    private JsonObject moveStatusResponse() {
        JsonObject response = baseResponse();
        response.addProperty("status", moveTask == null ? "idle" : moveTask.state);
        if (moveTask != null) response.add("move", moveTask.toJson());
        return response;
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
                    requireNoAtomicTask();
                    if (miningTask != null && miningTask.isActive()) {
                        throw new IllegalStateException("已有挖矿任务正在运行");
                    }
                    if (followTask != null && followTask.isActive()) {
                        throw new IllegalStateException("正在跟随玩家，请先停止跟随再开始挖矿");
                    }
                    if (client.player.isSpectator() || !client.player.isAlive() || client.player.getHealth() <= 6
                        || client.player.getFoodData().getFoodLevel() <= 6 || client.player.isInLava()) throw new IllegalStateException("玩家状态不适合开始挖矿");
                    requireMiningInventoryAccess();
                    MiningTask nextTask = new MiningTask(plan);
                    nextTask.inventorySnapshot = inventoryResponse();
                    if (!equipMiningPickaxe(nextTask, null, null)) throw new IllegalStateException("背包中没有可用的镐，无法开始自动挖矿");
                    stopMiningTicker();
                    miningTask = nextTask;
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
        try { requireMiningInventoryAccess(); }
        catch (IllegalStateException failure) {
            task.finish("safety_stop", failure.getMessage()); stopMiningTicker(); return;
        }
        if (System.currentTimeMillis() < task.toolReadyAt) {
            releaseForwardInput(); task.state = "equipping"; return;
        }
        if (task.plan.returnWhenFull && inventoryFull()) {
            task.finish("inventory_full", "背包已满");
            stopMiningTicker();
            return;
        }
        BlockPos target = findMiningTarget(task);
        try {
            var targetState = target == null ? null : client.level.getBlockState(target);
            if (!equipMiningPickaxe(task, targetState, target)) {
                task.finish("safety_stop", target == null ? "背包中没有可用的镐" : "背包中没有能正确采集目标方块的镐");
                stopMiningTicker(); return;
            }
            if (System.currentTimeMillis() < task.toolReadyAt) {
                releaseForwardInput(); task.state = "equipping"; return;
            }
        } catch (Exception failure) {
            task.finish("safety_stop", failure.getMessage() == null ? "切换镐子失败" : failure.getMessage());
            stopMiningTicker(); return;
        }
        if (target == null) {
            task.state = "waiting_target";
            task.message = "已装备镐子，等待附近的目标方块";
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
        task.message = "使用已选择的镐子挖掘目标方块";
        try {
            var targetState = client.level.getBlockState(target);
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
        task.message = "已装备镐子，正在靠近目标方块";
    }

    private void releaseForwardInput() {
        if (miningTask == null) return;
        client.options.keyUp.setDown(miningTask.forwardWasDown);
    }

    private void requireMiningInventoryAccess() {
        if (client.player.containerMenu != client.player.inventoryMenu || client.gui.screen() != null) throw new IllegalStateException("请关闭容器或游戏界面后再挖矿");
        if (!client.player.inventoryMenu.getCarried().isEmpty()) throw new IllegalStateException("鼠标上仍有物品，请先放回背包");
    }

    private boolean equipMiningPickaxe(MiningTask task, net.minecraft.world.level.block.state.BlockState targetState, BlockPos target) {
        requireMiningInventoryAccess();
        var inventory = client.player.getInventory();
        List<MiningToolSelector.Tool> tools = new ArrayList<>();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            var stack = inventory.getItem(slot);
            if (stack.isEmpty()) continue;
            String id = stack.getItem().builtInRegistryHolder().getRegisteredName();
            if (!MiningToolSelector.PRIORITY.contains(id)) continue;
            boolean suitable = targetState == null || (stack.canDestroyBlock(targetState, client.level, target, client.player)
                && (!targetState.requiresCorrectToolForDrops() || stack.isCorrectToolForDrops(targetState)));
            tools.add(new MiningToolSelector.Tool(slot, id, stack.isBroken(), suitable));
        }
        var chosen = MiningToolSelector.choose(tools, inventory.getSelectedSlot());
        if (chosen == null) return false;
        int hotbarSlot = chosen.slot();
        boolean swapped = hotbarSlot >= 9;
        if (swapped) {
            if (++task.equipAttempts > 3) throw new IllegalStateException("服务器未确认背包镐子的交换，请检查背包状态后重试");
            hotbarSlot = inventory.getSelectedSlot();
            for (int slot = 0; slot < 9; slot++) {
                if (inventory.getItem(slot).isEmpty()) { hotbarSlot = slot; break; }
            }
            var source = client.player.inventoryMenu.findSlot(inventory, chosen.slot());
            if (source.isEmpty()) throw new IllegalStateException("无法定位背包中的镐子槽位");
            // A normal numbered-key SWAP moves the displaced hotbar item back to the
            // source slot. Do not mutate local inventory stacks or drop any items.
            client.gameMode.handleContainerInput(client.player.inventoryMenu.containerId, source.getAsInt(), hotbarSlot, ContainerInput.SWAP, client.player);
            var equipped = inventory.getItem(hotbarSlot);
            if (equipped.isEmpty() || equipped.isBroken() || !chosen.itemId().equals(equipped.getItem().builtInRegistryHolder().getRegisteredName())) {
                throw new IllegalStateException("镐子交换失败，挖矿未开始");
            }
        } else {
            task.equipAttempts = 0;
        }
        boolean changedSlot = inventory.getSelectedSlot() != hotbarSlot;
        inventory.setSelectedSlot(hotbarSlot);
        if (changedSlot || swapped) client.player.connection.send(new ServerboundSetCarriedItemPacket(hotbarSlot));
        task.selectedTool = inventoryItemJson(hotbarSlot);
        if (swapped || changedSlot || task.toolReadyAt == 0) {
            task.selectedTool.addProperty("sourceSlot", chosen.slot());
            task.toolReadyAt = System.currentTimeMillis() + (swapped ? 350 : 150);
            task.state = "equipping";
            task.message = "已选择 " + inventory.getItem(hotbarSlot).getHoverName().getString() + "，正在切换镐子";
        }
        return true;
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
                    if (!isTargetBlock(task.plan.targetBlocks, id)) continue;
                    double distance = client.player.distanceToSqr(candidate.getX() + 0.5, candidate.getY() + 0.5, candidate.getZ() + 0.5);
                    if (distance > 25.0 || distance >= bestDistance) continue;
                    best = candidate;
                    bestDistance = distance;
                }
            }
        }
        return best;
    }

    private boolean isTargetBlock(Set<String> targets, String blockId) {
        if (targets.contains(blockId)) return true;
        if (blockId.startsWith("minecraft:deepslate_")) {
            String baseId = "minecraft:" + blockId.substring("minecraft:deepslate_".length());
            return targets.contains(baseId);
        }
        return false;
    }

    private boolean inventoryFull() {
        var inventory = client.player.getInventory();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            if (inventory.getItem(slot).isEmpty()) return false;
        }
        return true;
    }

    private void stopMiningTicker() {
        if (miningTicker != null) {
            releaseForwardInput();
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
        if (targets.isEmpty()) {
            targets.add("minecraft:coal_ore");
            targets.add("minecraft:iron_ore");
            targets.add("minecraft:copper_ore");
            targets.add("minecraft:gold_ore");
            targets.add("minecraft:diamond_ore");
            targets.add("minecraft:redstone_ore");
            targets.add("minecraft:lapis_ore");
            targets.add("minecraft:emerald_ore");
        }
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

    private record FollowPlan(UUID targetUuid, String targetName, double followDistance, double maxMinutes, boolean ignoreSafety) {}

    private static final class AtomicTask {
        final String id = UUID.randomUUID().toString();
        final String kind;
        final BlockPos position;
        final String before;
        final net.minecraft.client.multiplayer.ClientLevel level;
        final long startedAt = System.currentTimeMillis();
        boolean active = true;
        boolean sent;
        long changedAt;
        String state = "running";
        String message = "正在执行方块操作";
        String expected;
        String itemId;
        JsonObject selectedItem;
        Direction face;

        AtomicTask(String kind, BlockPos position, String before, net.minecraft.client.multiplayer.ClientLevel level) {
            this.kind = kind; this.position = position; this.before = before; this.level = level;
        }

        JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("id", id); json.addProperty("kind", kind); json.addProperty("active", active);
            json.addProperty("state", state); json.addProperty("message", message);
            json.addProperty("beforeBlockId", before); json.addProperty("expectedBlockId", expected);
            json.addProperty("changed", state.equals("completed"));
            json.addProperty("verification", "client_snapshot");
            if (selectedItem != null) json.add("selectedTool", selectedItem);
            json.addProperty("startedAt", startedAt); json.add("position", MiningTask.blockPositionJson(position));
            return json;
        }
    }

    private static final class MoveTask {
        final String id = UUID.randomUUID().toString();
        final BlockPos position;
        final double distance;
        final net.minecraft.client.multiplayer.ClientLevel level;
        final long startedAt = System.currentTimeMillis();
        final ArrayDeque<FollowPathfinder.Point> waypoints = new ArrayDeque<>();
        Vec3 lastPosition;
        boolean active = true;
        String state = "pathfinding";
        String message = "正在寻找安全路线";
        long nextRepathAt;
        long noPathSince;
        int stalledTicks;

        MoveTask(BlockPos position, double distance, net.minecraft.client.multiplayer.ClientLevel level, Vec3 lastPosition) {
            this.position = position; this.distance = distance; this.level = level; this.lastPosition = lastPosition;
        }

        JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("id", id); json.addProperty("state", state); json.addProperty("active", active);
            json.addProperty("message", message); json.addProperty("distance", distance);
            json.addProperty("startedAt", startedAt); json.add("position", MiningTask.blockPositionJson(position));
            json.addProperty("remainingWaypoints", waypoints.size());
            return json;
        }
    }

    private static final class FollowTask {
        private final FollowPlan plan;
        private final UUID targetUuid;
        private final String targetName;
        private final net.minecraft.client.multiplayer.ClientLevel level;
        private final long startedAt = System.currentTimeMillis();
        private String state = "following";
        private String message = "跟随任务已创建";
        private double distance;
        private net.minecraft.world.phys.Vec3 lastPosition;
        private int stalledTicks;
        private boolean ownsInput = true;
        private boolean ignoreSafety;
        private final ArrayDeque<FollowPathfinder.Point> waypoints = new ArrayDeque<>();
        private long nextRepathAt;
        private long noPathSince;
        private String navigation = "searching";

        private FollowTask(FollowPlan plan, Player target, net.minecraft.client.multiplayer.ClientLevel level, net.minecraft.world.phys.Vec3 position) {
            this.plan = plan;
            this.targetUuid = target.getUUID();
            this.targetName = target.getGameProfile().name();
            this.level = level;
            this.lastPosition = position;
            this.ignoreSafety = plan.ignoreSafety();
        }

        private boolean isActive() { return Set.of("following", "holding", "paused", "pathfinding").contains(state); }
        private void finish(String state, String message) { this.state = state; this.message = message; }

        private JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("state", state);
            json.addProperty("active", isActive());
            json.addProperty("message", message);
            json.addProperty("targetUuid", targetUuid.toString());
            json.addProperty("targetName", targetName);
            json.addProperty("distance", distance);
            json.addProperty("navigation", navigation);
            json.addProperty("ignoreSafety", ignoreSafety);
            json.addProperty("remainingWaypoints", waypoints.size());
            json.addProperty("followDistance", plan.followDistance);
            json.addProperty("maxMinutes", plan.maxMinutes);
            json.addProperty("startedAt", startedAt);
            json.addProperty("elapsedMs", Math.max(0, System.currentTimeMillis() - startedAt));
            return json;
        }
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
        private JsonObject inventorySnapshot;
        private JsonObject selectedTool;
        private long toolReadyAt;
        private int equipAttempts;

        private MiningTask(MiningPlan plan) { this.plan = plan; }

        private boolean isActive() {
            return Set.of("running", "equipping", "moving", "breaking", "waiting_target").contains(state);
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
            json.addProperty("toolSelectionPolicy", "pickaxe_priority_v1");
            if (inventorySnapshot != null) json.add("inventoryBeforeStart", inventorySnapshot);
            if (selectedTool != null) json.add("selectedTool", selectedTool);
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
