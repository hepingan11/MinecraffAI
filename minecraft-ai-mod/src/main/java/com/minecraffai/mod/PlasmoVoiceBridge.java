package com.minecraffai.mod;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** Adapter for Plasmo Voice 2.2. Uses only the server's ordinary proximity activation. */
final class PlasmoVoiceBridge {
    private PlasmoVoiceBridge() {}

    record Context(Object client, Object capture, Object serverInfo, Object connection,
                   Object udp, Object activation, Object codecInfo, int sampleRate, int frameSize, int mtu) {}

    static Context prepare(Object client) throws Exception {
        Object serverInfo = required(call(client, "getServerInfo"), "Plasmo Voice 尚未收到服务器语音配置");
        Object connection = required(call(client, "getServerConnection"), "Plasmo Voice 未连接语音服务器");
        Object manager = call(client, "getUdpClientManager");
        Object udp = required(call(manager, "getClient"), "Plasmo Voice UDP 未连接");
        if (!Boolean.TRUE.equals(call(manager, "isConnected"))
                || !Boolean.TRUE.equals(call(udp, "isConnected"))
                || Boolean.TRUE.equals(call(udp, "isClosed"))
                || Boolean.TRUE.equals(call(udp, "isTimedOut"))) {
            throw new IllegalStateException("Plasmo Voice UDP 未连接或已超时");
        }
        Object capture = call(client, "getAudioCapture");
        if (capture == null) throw new IllegalStateException("Plasmo Voice 音频捕获模块不可用");
        if (Boolean.TRUE.equals(call(capture, "isServerMuted"))) throw new IllegalStateException("服务器已将当前玩家静音");
        Object player = required(call(connection, "getLocalPlayer"), "Plasmo Voice 未收到当前玩家语音信息");
        if (Boolean.TRUE.equals(call(player, "isMuted"))) throw new IllegalStateException("服务器已将当前玩家静音");
        if (Boolean.TRUE.equals(call(player, "isMicrophoneMuted"))) throw new IllegalStateException("Plasmo Voice 麦克风已静音，请先在语音设置中取消静音");

        Object activations = call(client, "getActivationManager");
        Collection<?> all = (Collection<?>) call(activations, "getActivations");
        Object parent = ((Optional<?>) call(activations, "getParentActivation")).orElse(null);
        Object selected = selectProximity(parent, all);
        ensureNoMicrophoneStream(all, parent);
        if (Boolean.TRUE.equals(call(selected, "isDisabled"))) throw new IllegalStateException("Plasmo Voice 附近语音通道已禁用");
        int distance = ((Number) call(selected, "getDistance")).intValue();
        if (!Boolean.TRUE.equals(call(selected, "checkDistance", distance))) throw new IllegalStateException("Plasmo Voice 语音距离无效");

        Object voiceInfo = call(serverInfo, "getVoiceInfo");
        Object captureInfo = call(voiceInfo, "getCaptureInfo");
        int sampleRate = ((Number) call(captureInfo, "getSampleRate")).intValue();
        int frameSize = ((Number) call(voiceInfo, "getFrameSize")).intValue();
        int mtu = ((Number) call(captureInfo, "getMtuSize")).intValue();
        if (sampleRate < 8_000 || sampleRate > 48_000 || frameSize != sampleRate / 50 || mtu <= 0) {
            throw new IllegalStateException("Plasmo Voice 服务器音频格式不受支持");
        }
        // Empty means inherit the server's default codec. It does NOT mean this channel is unavailable.
        Object codecInfo = ((Optional<?>) call(selected, "getEncoderInfo")).orElse(null);
        if (codecInfo == null) codecInfo = call(captureInfo, "getEncoderInfo");
        if (codecInfo == null) throw new IllegalStateException("Plasmo Voice 服务器未提供编码器配置");
        return new Context(client, capture, serverInfo, connection, udp, selected, codecInfo, sampleRate, frameSize, mtu);
    }

    static Object selectProximity(Object parent, Collection<?> activations) throws Exception {
        List<Object> candidates = new ArrayList<>();
        if (parent != null) candidates.add(parent);
        candidates.addAll(activations);
        for (Object activation : candidates) {
            if ("proximity".equals(call(activation, "getName"))
                    && Boolean.TRUE.equals(call(activation, "isProximity"))
                    && !"pv.activation.parent".equals(call(activation, "getTranslation"))) return activation;
        }
        throw new IllegalStateException("Plasmo Voice 服务器未提供普通附近语音通道；不会自动使用群组或广播通道");
    }

    static void ensureNoMicrophoneStream(Collection<?> all, Object parent) throws Exception {
        if (parent != null && Boolean.TRUE.equals(call(parent, "isActive"))) throw new IllegalStateException("真实麦克风正在讲话，请结束后再发送 AI 语音");
        for (Object activation : all) {
            if (Boolean.TRUE.equals(call(activation, "isActive"))) throw new IllegalStateException("真实麦克风正在讲话，请结束后再发送 AI 语音");
        }
    }

    static int send(Context context, short[] source, int sourceRate) throws Exception {
        Object codecManager = call(context.client(), "getCodecManager");
        // Never share the capture thread's native Opus encoder across threads.
        Object encoder = call(codecManager, "createEncoder", context.codecInfo(), context.sampleRate(), false, context.mtu());
        int framesSent = 0;
        try {
            if (!Boolean.TRUE.equals(call(encoder, "isOpen"))) call(encoder, "open");
            short[] samples = resample(source, sourceRate, context.sampleRate());
            long nextFrame = System.nanoTime();
            for (int offset = 0; offset < samples.length; offset += context.frameSize()) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException("语音发送已取消");
                Context current = prepare(context.client());
                if (current.connection() != context.connection() || current.udp() != context.udp()
                        || current.serverInfo() != context.serverInfo() || current.activation() != context.activation()) {
                    throw new IllegalStateException("Plasmo Voice 连接已变化，停止发送");
                }
                short[] frame = new short[context.frameSize()];
                System.arraycopy(samples, offset, frame, 0, Math.min(frame.length, samples.length - offset));
                byte[] encoded = (byte[]) call(encoder, "encode", (Object) frame);
                if (encoded == null || encoded.length == 0) throw new IllegalStateException("Plasmo Voice 编码器未返回音频数据");
                Object encryption = ((Optional<?>) call(context.serverInfo(), "getEncryption")).orElse(null);
                if (encryption != null) encoded = (byte[]) call(encryption, "encrypt", (Object) encoded);
                callPrivate(context.capture(), "sendVoicePacket", context.activation(), false, encoded);
                framesSent++;
                nextFrame += 20_000_000L;
                long remaining = nextFrame - System.nanoTime();
                if (remaining > 0) Thread.sleep(remaining / 1_000_000L, (int) (remaining % 1_000_000L));
            }
            return framesSent;
        } finally {
            try {
                if (framesSent > 0) callPrivate(context.capture(), "sendVoiceEndPacket", context.activation());
            } finally {
                call(encoder, "close");
            }
        }
    }

    static short[] resample(short[] samples, int sourceRate, int targetRate) {
        if (sourceRate == targetRate) return samples;
        short[] result = new short[(int) Math.ceil(samples.length * (double) targetRate / sourceRate)];
        for (int index = 0; index < result.length; index++) {
            double position = index * (double) sourceRate / targetRate;
            int first = Math.min(samples.length - 1, (int) position);
            int second = Math.min(samples.length - 1, first + 1);
            result[index] = (short) Math.round(samples[first] + (samples[second] - samples[first]) * (position - first));
        }
        return result;
    }

    private static Object required(Object optional, String error) {
        return ((Optional<?>) optional).orElseThrow(() -> new IllegalStateException(error));
    }

    static Object call(Object target, String name, Object... arguments) throws Exception {
        for (Method method : target.getClass().getMethods()) {
            if (matches(method, name, arguments)) return invoke(method, target, arguments);
        }
        throw new NoSuchMethodException(target.getClass().getName() + "." + name);
    }

    private static Object callPrivate(Object target, String name, Object... arguments) throws Exception {
        for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
            for (Method method : type.getDeclaredMethods()) {
                if (matches(method, name, arguments)) return invoke(method, target, arguments);
            }
        }
        throw new NoSuchMethodException(target.getClass().getName() + "." + name);
    }

    private static boolean matches(Method method, String name, Object[] arguments) {
        if (!method.getName().equals(name) || method.getParameterCount() != arguments.length) return false;
        Class<?>[] types = method.getParameterTypes();
        for (int index = 0; index < types.length; index++) {
            Class<?> type = types[index];
            if (type == boolean.class) type = Boolean.class;
            if (type == int.class) type = Integer.class;
            if (arguments[index] != null && !type.isInstance(arguments[index])) return false;
        }
        return true;
    }

    private static Object invoke(Method method, Object target, Object[] arguments) throws Exception {
        method.trySetAccessible();
        try { return method.invoke(target, arguments); }
        catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception exception) throw exception;
            if (cause instanceof Error fatal) throw fatal;
            throw error;
        }
    }
}
