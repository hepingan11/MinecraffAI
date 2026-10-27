import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { sendVoice, getVoiceStatus } from "../minecraft-mod-api.mjs";
import { AutoReplyService } from "../auto-reply.mjs";

test("voice reports real transport errors, rejects old queued responses and checks before TTS", async (t) => {
  let responseBody = { ok: true, voiceBridgeVersion: 2, completed: true, framesSent: 2 };
  let statusCode = 200;
  const calls = [];
  const mod = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-voice-token");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, method: req.method, bytes: Buffer.concat(chunks).length });
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
  mod.listen(0, "127.0.0.1"); await once(mod, "listening");
  t.after(() => new Promise((resolve) => mod.close(resolve)));
  const window = { host: "127.0.0.1", port: mod.address().port, token: "test-voice-token" };
  const wav = Buffer.alloc(44);
  await sendVoice(window, wav, { mode: "microphone" });
  assert.deepEqual(calls.at(-1), { url: "/voice?mode=microphone", method: "POST", bytes: 44 });
  responseBody = { ok: true, queued: true };
  await assert.rejects(sendVoice(window, wav), /Mod/);
  statusCode = 400; responseBody = { ok: false, error: "UDP disconnected" };
  await assert.rejects(sendVoice(window, wav), /UDP disconnected/);
  statusCode = 200; responseBody = { ok: true, voiceBridgeVersion: 2, microphoneReady: false, microphoneError: "Server muted" };
  assert.equal((await getVoiceStatus(window)).microphoneReady, false);
  const service = new AutoReplyService();
  service.config = { ...service.config, voiceOutput: "microphone", voiceProvider: "voicerss", voiceApiKey: "fake" };
  await assert.rejects(service.generateAndSendVoice(window, "测试"), /Server muted/);
  assert.equal(calls.at(-1).method, "GET");
  assert.equal(service.status.voicePlayed, 0);
  const count = calls.length;
  await assert.rejects(sendVoice(window, wav, { mode: "broadcast" }), /模式/);
  assert.equal(calls.length, count);
});

test("chat keeps a voice failure visible after text was sent", async () => {
  const sent = [];
  const service = new AutoReplyService({ chatSender: async (_window, message) => sent.push(message) });
  service.config = { ...service.config, enabled: true, voiceReplyEnabled: true, triggerName: "bot" };
  service.selectTargetWindow = async () => ({ id: "test" });
  service.generateReply = async () => "你好";
  service.generateAndSendVoice = async () => { throw new Error("UDP disconnected"); };
  await service.processLine("[12:00:00] [Render thread/INFO]: [CHAT] <Steve> @bot 你好");
  assert.deepEqual(sent, ["你好"]);
  assert.match(service.status.lastError, /UDP disconnected/);
  assert.match(service.status.lastVoiceError, /UDP disconnected/);
  assert.equal(service.status.replied, 1);
  assert.equal(service.status.voicePlayed, 0);
});
