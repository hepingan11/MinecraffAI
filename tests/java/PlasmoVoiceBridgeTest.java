package com.minecraffai.mod;

import java.util.List;
import java.util.Optional;

public final class PlasmoVoiceBridgeTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void rejects(Client client, String expected) throws Exception {
        try { PlasmoVoiceBridge.prepare(client); throw new AssertionError("expected failure: " + expected); }
        catch (IllegalStateException error) { check(error.getMessage().contains(expected), error.getMessage()); }
    }

    public static void main(String[] args) throws Exception {
        Client client = new Client();
        var context = PlasmoVoiceBridge.prepare(client);
        check(context.activation() == client.activations.parent, "must choose ordinary proximity parent");
        check(context.codecInfo() == client.info.voice.capture.codec, "must inherit default codec when channel has none");
        check(client.activations.parent.getMonoEncoder().isEmpty(), "fixture must reproduce original failure");
        int sent = PlasmoVoiceBridge.send(context, new short[961], 48000);
        check(sent == 2 && client.capture.frames == 2 && client.capture.ends == 1, "must send padded final frame and end");
        check(client.codecs.encoder.opened && client.codecs.encoder.closed, "own encoder must be opened and closed");
        check(client.codecs.encoder.lastSize == 480, "must resample to server's 24 kHz 20 ms frames");
        check(client.info.encryption.calls == 2, "must encrypt each frame");
        check(client.capture.lastByte == 43, "must send encrypted audio");

        client.udp.timedOut = true; rejects(client, "UDP"); client.udp.timedOut = false;
        client.capture.muted = true; rejects(client, "静音"); client.capture.muted = false;
        client.connection.player.microphoneMuted = true; rejects(client, "静音"); client.connection.player.microphoneMuted = false;
        client.activations.parent.active = true; rejects(client, "真实麦克风"); client.activations.parent.active = false;
        client.activations.parent.disabled = true; rejects(client, "禁用"); client.activations.parent.disabled = false;
        client.activations.parent.name = "group"; rejects(client, "普通附近"); client.activations.parent.name = "proximity";

        // A dropped connection during transmission must fail and release the encoder.
        client.codecs.encoder = new Encoder();
        client.capture.dropConnection = true;
        try { PlasmoVoiceBridge.send(PlasmoVoiceBridge.prepare(client), new short[1920], 48000); throw new AssertionError("connection drop ignored"); }
        catch (IllegalStateException expected) { check(client.codecs.encoder.closed, "encoder leaked after disconnect"); }
        System.out.println("PlasmoVoiceBridge regression checks passed");
    }

    public static final class Client {
        final Info info = new Info(); final Connection connection = new Connection(); final Udp udp = new Udp();
        final Activations activations = new Activations(); final Capture capture = new Capture(udp); final Codecs codecs = new Codecs();
        public Optional<Info> getServerInfo() { return Optional.of(info); }
        public Optional<Connection> getServerConnection() { return Optional.of(connection); }
        public UdpManager getUdpClientManager() { return new UdpManager(udp); }
        public Activations getActivationManager() { return activations; }
        public Capture getAudioCapture() { return capture; }
        public Codecs getCodecManager() { return codecs; }
    }
    public static final class Info {
        final Voice voice = new Voice(); final Encryption encryption = new Encryption();
        public Voice getVoiceInfo() { return voice; }
        public Optional<Encryption> getEncryption() { return Optional.of(encryption); }
    }
    public static final class Voice {
        final CaptureInfo capture = new CaptureInfo();
        public CaptureInfo getCaptureInfo() { return capture; }
        public int getFrameSize() { return 480; }
    }
    public static final class CaptureInfo {
        final Object codec = new Object();
        public int getSampleRate() { return 24000; } public int getMtuSize() { return 1200; }
        public Object getEncoderInfo() { return codec; }
    }
    public static final class Connection {
        final Player player = new Player(); public Optional<Player> getLocalPlayer() { return Optional.of(player); }
    }
    public static final class Player {
        boolean microphoneMuted;
        public boolean isMuted() { return false; } public boolean isMicrophoneMuted() { return microphoneMuted; }
    }
    public static final class Udp {
        boolean timedOut;
        public boolean isConnected() { return !timedOut; } public boolean isClosed() { return false; }
        public boolean isTimedOut() { return timedOut; }
    }
    public record UdpManager(Udp udp) {
        public boolean isConnected() { return udp.isConnected(); } public Optional<Udp> getClient() { return Optional.of(udp); }
    }
    public static final class Activations {
        final Activation parent = new Activation();
        public Optional<Activation> getParentActivation() { return Optional.of(parent); }
        public List<Activation> getActivations() { return List.of(); }
    }
    public static final class Activation {
        String name = "proximity"; boolean active; boolean disabled;
        public String getName() { return name; } public String getTranslation() { return "pv.activation.proximity"; }
        public boolean isProximity() { return true; } public boolean isDisabled() { return disabled; }
        public boolean isActive() { return active; } public int getDistance() { return 16; }
        public boolean checkDistance(int distance) { return distance == 16; }
        public Optional<Object> getEncoderInfo() { return Optional.empty(); }
        public Optional<Object> getMonoEncoder() { return Optional.empty(); }
    }
    public static final class Codecs {
        Encoder encoder = new Encoder();
        public Encoder createEncoder(Object info, int sampleRate, boolean stereo, int mtu) {
            check(sampleRate == 24000 && !stereo && mtu == 1200, "server codec parameters ignored"); return encoder;
        }
    }
    public static final class Encoder {
        boolean opened; boolean closed; int lastSize;
        public boolean isOpen() { return opened; } public void open() { opened = true; } public void close() { closed = true; }
        public byte[] encode(short[] frame) { lastSize = frame.length; return new byte[]{42}; }
    }
    public static final class Encryption {
        int calls; public byte[] encrypt(byte[] frame) { calls++; return new byte[]{(byte) (frame[0] + 1)}; }
    }
    public static final class Capture {
        final Udp udp; int frames; int ends; int lastByte; boolean muted; boolean dropConnection;
        Capture(Udp udp) { this.udp = udp; }
        public boolean isServerMuted() { return muted; }
        private void sendVoicePacket(Activation activation, boolean stereo, byte[] encoded) {
            frames++; lastByte = encoded[0]; if (dropConnection) udp.timedOut = true;
        }
        private void sendVoiceEndPacket(Activation activation) { ends++; }
    }
}
