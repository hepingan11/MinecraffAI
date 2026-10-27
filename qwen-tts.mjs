import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const QWEN_TTS_URL = "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/realtime";
export const QWEN_TTS_MODEL = "qwen3-tts-flash-realtime";
export const QWEN_TTS_VOICE = "Cherry";
const SAMPLE_RATE = 24000;
const MAX_PCM_BYTES = 4 * 1024 * 1024 - 44;
const LANGUAGES = Object.freeze({ zh: "Chinese", en: "English", de: "German", it: "Italian", pt: "Portuguese", es: "Spanish", ja: "Japanese", ko: "Korean", fr: "French", ru: "Russian" });

export function normalizeQwenTtsUrl(value) {
  let url;
  try { url = new URL(value || QWEN_TTS_URL); } catch { throw new Error("千问 TTS 地址必须是有效的 wss WebSocket 地址"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local)) throw new Error("千问 TTS 必须使用 wss，仅本机代理允许 ws");
  if (url.username || url.password || url.hash) throw new Error("千问 TTS 地址不能包含用户名、密码或片段");
  if (url.pathname === "/") url.pathname = "/api-ws/v1/realtime";
  return url.toString();
}

export function validateQwenTtsConfig(config, { requireKey = true } = {}) {
  normalizeQwenTtsUrl(config.voiceBaseUrl);
  if (!/^qwen3-tts-[a-z0-9-]*realtime(?:-[a-z0-9-]+)?$/u.test(config.voiceModel)) throw new Error("千问 TTS 需要 qwen3-tts-…realtime 语音合成模型");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(config.voice)) throw new Error("千问 TTS 音色必须使用官方音色 ID，例如 Cherry、Serena、Ethan");
  if (!LANGUAGES[config.voiceLanguage?.split("-")[0]]) throw new Error("千问 TTS 不支持该语音语言");
  if (!Number.isInteger(config.voiceRate) || config.voiceRate < -10 || config.voiceRate > 10) throw new Error("语音速度必须在 -10 到 10 之间");
  if (requireKey && !config.voiceApiKey) throw new Error("使用千问 TTS 必须配置独立的语音 API Key");
  if (config.voiceApiKey && /[\r\n]/u.test(config.voiceApiKey)) throw new Error("千问 TTS API Key 不能包含换行");
}

function pcmToWav(chunks, length) {
  if (!length || length > MAX_PCM_BYTES || length % 2 !== 0) throw new Error("千问 TTS 返回的 PCM 音频大小无效");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(length, 40);
  return Buffer.concat([header, ...chunks], 44 + length);
}

// Qwen-TTS Realtime client/server events: session.update → append → finish.
export async function synthesizeQwenTts(config, text, { timeoutMs = 30_000 } = {}) {
  validateQwenTtsConfig(config);
  if (typeof text !== "string" || !text.trim() || text.length > 500) throw new Error("千问 TTS 文本长度必须在 1 到 500 之间");
  const url = new URL(normalizeQwenTtsUrl(config.voiceBaseUrl));
  url.searchParams.set("model", config.voiceModel);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.voiceApiKey}` },
      handshakeTimeout: timeoutMs,
      maxPayload: 6 * 1024 * 1024,
      followRedirects: false,
    });
    const chunks = [];
    let length = 0;
    let settled = false;
    let submitted = false;
    const complete = (error, audio) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) socket.terminate();
      else socket.close();
      if (error) reject(error);
      else resolve(audio);
    };
    const timer = setTimeout(() => complete(new Error("千问 TTS 合成超时")), timeoutMs);
    const send = (type, fields = {}) => socket.send(JSON.stringify({ event_id: randomUUID(), type, ...fields }));
    socket.on("open", () => send("session.update", { session: {
      voice: config.voice,
      mode: "server_commit",
      language_type: LANGUAGES[config.voiceLanguage.split("-")[0]],
      response_format: "pcm",
      sample_rate: SAMPLE_RATE,
      speech_rate: 2 ** (config.voiceRate / 10),
    } }));
    socket.on("message", (data, binary) => {
      if (settled) return;
      try {
        if (binary) throw new Error("千问 TTS 返回了非 JSON 消息");
        const event = JSON.parse(data.toString("utf8"));
        if (event.type === "error") throw new Error(`千问 TTS：${String(event.error?.message || event.error?.code || "接口返回错误").slice(0, 1000)}`);
        if (event.type === "session.updated" && !submitted) {
          const session = event.session;
          if (session?.response_format !== "pcm" || session?.sample_rate !== SAMPLE_RATE) throw new Error("千问 TTS 未确认 24 kHz PCM 音频格式");
          submitted = true;
          send("input_text_buffer.append", { text });
          send("session.finish");
        } else if (event.type === "response.audio.delta") {
          if (!submitted) throw new Error("千问 TTS 在提交文本前返回了音频");
          if (typeof event.delta !== "string" || !event.delta.length || event.delta.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(event.delta)) throw new Error("千问 TTS 返回了无效的 Base64 音频");
          const chunk = Buffer.from(event.delta, "base64");
          length += chunk.length;
          if (length > MAX_PCM_BYTES) throw new Error("千问 TTS 音频超过 4 MB 上限");
          chunks.push(chunk);
        } else if (event.type === "response.done" && event.response?.status && event.response.status !== "completed") {
          throw new Error(`千问 TTS 合成未完成：${String(event.response.status).slice(0, 100)}`);
        } else if (event.type === "session.finished") {
          complete(null, pcmToWav(chunks, length));
        }
      } catch (error) { complete(error); }
    });
    socket.on("error", (error) => complete(new Error(`千问 TTS 连接失败：${error.message}`)));
    socket.on("close", (code) => complete(new Error(`千问 TTS 连接提前关闭（${code}）`)));
  });
}
