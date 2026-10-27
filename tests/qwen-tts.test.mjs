import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { QWEN_TTS_URL, QWEN_TTS_MODEL, normalizeQwenTtsUrl, synthesizeQwenTts } from "../qwen-tts.mjs";
import { AutoReplyService, DEFAULT_CONFIG, normalizeConfig, publicConfig } from "../auto-reply.mjs";

async function realtimeServer(t, handler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket, request) => {
    const send = (event) => socket.send(JSON.stringify(event));
    socket.on("message", (data) => handler(JSON.parse(data.toString()), send, socket, request));
  });
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    return new Promise((resolve) => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}/api-ws/v1/realtime`;
}

function qwenConfig(voiceBaseUrl, extra = {}) {
  return normalizeConfig({ voiceProvider: "qwen", voiceBaseUrl, voiceApiKey: "test-qwen-secret", ...extra });
}

test("千问配置由后端设置默认值、校验参数，公开配置不返回 Key", () => {
  const config = qwenConfig("");
  assert.equal(config.voiceModel, QWEN_TTS_MODEL);
  assert.equal(config.voice, "Cherry");
  assert.equal(normalizeQwenTtsUrl(config.voiceBaseUrl), QWEN_TTS_URL);
  assert.equal(normalizeQwenTtsUrl("wss://dashscope.aliyuncs.com"), "wss://dashscope.aliyuncs.com/api-ws/v1/realtime");
  assert.equal(publicConfig(config).voiceApiKeySet, true);
  assert.equal(publicConfig(config).voiceApiKey, undefined);
  assert.throws(() => normalizeConfig({ voiceProvider: "qwen", voiceReplyEnabled: true }), /API Key/u);
  assert.throws(() => normalizeConfig({ clearVoiceApiKey: true, voiceReplyEnabled: true }, config), /API Key/u);
  for (const voiceBaseUrl of ["https://example.com", "ws://example.com", "wss://user:password@example.com", "wss://example.com/#key", "invalid"]) {
    assert.throws(() => qwenConfig(voiceBaseUrl), /地址|wss/u);
  }
  for (const voiceModel of ["gpt-4o-mini-tts", "qwen-audio-3.0-realtime-flash", "qwen3-tts-flash"]) {
    assert.throws(() => qwenConfig("", { voiceModel }), /模型/u);
  }
  assert.throws(() => qwenConfig("", { voice: "Cherry\nInjected" }), /音色/u);
  assert.throws(() => qwenConfig("", { voiceLanguage: "xx-xx" }), /语言/u);
  assert.throws(() => qwenConfig("", { voiceApiKey: "key\nInjected: true" }), /换行/u);
  assert.throws(() => qwenConfig("", { voiceRate: 11 }), /速度/u);
  assert.equal(normalizeConfig({ voiceRate: 3 }, config).voice, "Cherry");
  assert.equal(normalizeConfig({ voiceProvider: "openai" }, config).voice, DEFAULT_CONFIG.voice);
  assert.equal(normalizeConfig({ voiceProvider: "openai" }, config).voiceBaseUrl, "");
});

test("真实 WebSocket 握手带独立 Key，确认配置后提交文本，完整合成 PCM 转 WAV", async (t) => {
  const events = [];
  const samples = Buffer.from([1, 0, 255, 127, 0, 128]);
  const url = await realtimeServer(t, (event, send, _socket, request) => {
    events.push(event);
    assert.equal(request.headers.authorization, "Bearer test-qwen-secret");
    assert.equal(new URL(request.url, "http://localhost").searchParams.get("model"), QWEN_TTS_MODEL);
    if (event.type === "session.update") {
      assert.deepEqual(event.session, { voice: "Cherry", mode: "server_commit", language_type: "Chinese", response_format: "pcm", sample_rate: 24000, speech_rate: 1 });
      send({ type: "session.created" });
      send({ type: "session.updated", session: event.session });
    } else if (event.type === "input_text_buffer.append") {
      assert.equal(event.text, "你好，Minecraft！");
    } else if (event.type === "session.finish") {
      // A PCM frame may be split between deltas; only the final size must be even.
      send({ type: "response.audio.delta", delta: samples.subarray(0, 3).toString("base64") });
      send({ type: "response.done", response: { status: "completed" } });
      send({ type: "response.audio.delta", delta: samples.subarray(3).toString("base64") });
      send({ type: "session.finished" });
    }
  });
  const wav = await synthesizeQwenTts(qwenConfig(`${url}?proxy=1&model=old`), "你好，Minecraft！");
  assert.deepEqual(events.map((event) => event.type), ["session.update", "input_text_buffer.append", "session.finish"]);
  assert.equal(new Set(events.map((event) => event.event_id)).size, 3);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), samples.length);
  assert.deepEqual(wav.subarray(44), samples);
});

test("千问服务错误、畸形音频、空音频、超限和提前断开均拒绝", async (t) => {
  const cases = [
    ["API error", (send) => send({ type: "error", error: { message: "Invalid API key" } }), /Invalid API key/u],
    ["invalid JSON", (_send, socket) => socket.send("{"), /JSON/u],
    ["binary", (_send, socket) => socket.send(Buffer.from([0, 1])), /JSON/u],
    ["invalid base64", (send) => send({ type: "response.audio.delta", delta: "%%%=" }), /Base64/u],
    ["empty", (send) => send({ type: "session.finished" }), /PCM/u],
    ["odd PCM", (send) => { send({ type: "response.audio.delta", delta: "AQ==" }); send({ type: "session.finished" }); }, /PCM/u],
    ["oversize", (send) => send({ type: "response.audio.delta", delta: Buffer.alloc(4 * 1024 * 1024).toString("base64") }), /4 MB/u],
    ["failed response", (send) => send({ type: "response.done", response: { status: "failed" } }), /未完成/u],
    ["early close", (_send, socket) => socket.close(), /提前关闭/u],
  ];
  for (const [name, respond, pattern] of cases) {
    await t.test(name, async (t) => {
      const url = await realtimeServer(t, (event, send, socket) => {
        if (event.type === "session.update") send({ type: "session.updated", session: event.session });
        if (event.type === "session.finish") respond(send, socket);
      });
      await assert.rejects(synthesizeQwenTts(qwenConfig(url), "测试"), pattern);
    });
  }
});

test("千问超时和格式协商失败关闭连接，不提交文本", async (t) => {
  let messages = 0;
  const url = await realtimeServer(t, () => { messages += 1; });
  await assert.rejects(synthesizeQwenTts(qwenConfig(url), "测试", { timeoutMs: 100 }), /超时/u);
  assert.equal(messages, 1);
  const mismatch = await realtimeServer(t, (_event, send) => send({ type: "session.updated", session: { response_format: "mp3", sample_rate: 48000 } }));
  await assert.rejects(synthesizeQwenTts(qwenConfig(mismatch), "测试"), /音频格式/u);
  await assert.rejects(synthesizeQwenTts(qwenConfig(url), " "), /文本长度/u);
  await assert.rejects(synthesizeQwenTts(qwenConfig(url), "字".repeat(501)), /文本长度/u);
});

test("千问握手 HTTP 认证失败直接报告错误", async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(synthesizeQwenTts(qwenConfig(`ws://127.0.0.1:${server.address().port}`), "测试"), /401/u);
});

test("千问接入现有 Mod 播放链路，失败不增加成功计数", async (t) => {
  let fail = false;
  let ttsCalls = 0;
  let received;
  const url = await realtimeServer(t, (event, send) => {
    if (event.type === "session.update") { ttsCalls += 1; send({ type: "session.updated", session: event.session }); }
    if (event.type === "input_text_buffer.append") assert.equal(event.text, "你好");
    if (event.type === "session.finish") {
      if (fail) send({ type: "error", error: { message: "Quota exceeded" } });
      else {
        send({ type: "response.audio.delta", delta: "AAAAAA==" });
        send({ type: "session.finished" });
      }
    }
  });
  let ready = true;
  let modFail = false;
  const mod = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer mod-token");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST") {
      assert.equal(req.url, "/voice?mode=microphone");
      received = Buffer.concat(chunks);
    }
    res.writeHead(req.method === "POST" && modFail ? 400 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: !(req.method === "POST" && modFail), voiceBridgeVersion: 2, completed: true, microphoneReady: ready, microphoneError: "Server muted", error: "UDP disconnected" }));
  });
  mod.listen(0, "127.0.0.1"); await once(mod, "listening");
  t.after(() => new Promise((resolve) => mod.close(resolve)));
  const window = { host: "127.0.0.1", port: mod.address().port, token: "mod-token" };
  const service = new AutoReplyService();
  service.config = qwenConfig(url, { voiceReplyEnabled: true, voiceOutput: "microphone", voiceMaxChars: 2 });
  await service.generateAndSendVoice(window, "你好 Minecraft");
  assert.equal(received.toString("ascii", 0, 4), "RIFF");
  assert.equal(service.status.voicePlayed, 1);
  fail = true;
  await assert.rejects(service.generateAndSendVoice(window, "你好"), /Quota exceeded/u);
  assert.equal(service.status.voicePlayed, 1);
  fail = false; modFail = true;
  await assert.rejects(service.generateAndSendVoice(window, "你好"), /UDP disconnected/u);
  assert.equal(service.status.voicePlayed, 1);
  ready = false;
  const before = ttsCalls;
  await assert.rejects(service.generateAndSendVoice(window, "你好"), /Server muted/u);
  assert.equal(ttsCalls, before);
});
