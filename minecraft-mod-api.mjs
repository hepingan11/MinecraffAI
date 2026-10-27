import http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { PICKAXE_PRIORITY, recognizeMiningPickaxes } from "./mining-tools.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { validateSchema } from "./tool-registry.mjs";
import { SCAN_BLOCKS_SCHEMA, BREAK_BLOCK_SCHEMA, PLACE_BLOCK_SCHEMA, MOVE_TO_SCHEMA } from "./minecraft-atomic-schema.mjs";
import { RECIPES_SCHEMA, CRAFT_SCHEMA } from "./minecraft-crafting-schema.mjs";

const DEFAULT_REGISTRY_DIR = String.raw`G:\Game\[PCL启动器打包]RO26.2性能优化+生电轻量版 1.0.1\.minecraft\versions\[PCL启动器打包]RO26.2性能优化+生电轻量版\minecraft-ai\windows`;

export function getRegistryDir() {
  return process.env.MC_AI_REGISTRY_DIR?.trim() || DEFAULT_REGISTRY_DIR;
}

function requestJson(window, pathname, { method = "GET", body, timeoutMs = 4000, allowErrorBody = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = http.request({
      hostname: window.host,
      port: window.port,
      path: pathname,
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        }),
        ...(window.token ? { Authorization: `Bearer ${window.token}` } : {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let value;
        try { value = text ? JSON.parse(text) : {}; } catch { value = { ok: false, error: "Mod API 返回了无效 JSON" }; }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || (value.ok === false && !allowErrorBody)) {
          reject(new Error(value.error || `Mod API 请求失败（${response.statusCode ?? "unknown"}）`));
        } else {
          resolve(value);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Mod API 请求超时"));
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function requestBinary(window, pathname, payload, { contentType = "application/octet-stream", timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: window.host,
      port: window.port,
      path: pathname,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
        "Content-Length": payload.length,
        ...(window.token ? { Authorization: `Bearer ${window.token}` } : {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let value;
        try { value = text ? JSON.parse(text) : {}; } catch { value = { ok: false, error: "Mod API 返回了无效 JSON" }; }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || value.ok === false) {
          reject(new Error(value.error || `Mod API 请求失败（${response.statusCode ?? "unknown"}）`));
        } else resolve(value);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Mod API 请求超时")));
    request.on("error", reject);
    request.end(payload);
  });
}

function normalizeWindow(raw, filename) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const host = String(raw.host ?? "127.0.0.1").trim();
  const port = Number(raw.port);
  const token = String(raw.token ?? "").trim();
  if (!id || !token || !["127.0.0.1", "localhost"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    id,
    host,
    port,
    token,
    title: String(raw.title ?? `Minecraft · ${id}`),
    app: "fabric-mod",
    registryFile: filename,
  };
}

export function publicWindow(window) {
  return {
    id: window.id,
    title: window.title,
    app: window.app,
    port: window.port,
    transport: "fabric-mod",
  };
}

export function validateMessage(message) {
  if (typeof message !== "string" || message.trim() === "") throw new Error("消息不能为空");
  if (message.length > 256) throw new Error("消息长度不能超过 256 个字符");
  if (/[\r\n]/u.test(message)) throw new Error("消息不能包含换行");
  return message.trim();
}

export async function discoverWindows() {
  let entries;
  try {
    entries = await readdir(getRegistryDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const windows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(`${getRegistryDir()}\\${entry.name}`, "utf8"));
      const window = normalizeWindow(raw, entry.name);
      if (!window) continue;
      const health = await requestJson(window, "/health");
      if (health.ok !== true) continue;
      windows.push({ ...window, title: String(health.title ?? window.title), connected: health.connected !== false });
    } catch {
      // Stale registry entries are ignored; the client removes them on shutdown.
    }
  }
  return windows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function sendChat(window, message) {
  return requestJson(window, "/chat", { method: "POST", body: { message: validateMessage(message) }, timeoutMs: 8000 });
}

export async function sendVoice(window, wavBuffer, { mode = "local" } = {}) {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44 || wavBuffer.length > 4 * 1024 * 1024) {
    throw new Error("语音音频大小必须在 44 字节到 4 MB 之间");
  }
  if (!["local", "microphone"].includes(mode)) throw new Error("语音播放模式无效");
  const result = await requestBinary(window, `/voice?mode=${encodeURIComponent(mode)}`, wavBuffer, { contentType: "audio/wav", timeoutMs: 40_000 });
  if (result.voiceBridgeVersion !== 2 || result.completed !== true) throw new Error("Mod 仅将语音入队，无法确认发送结果；请完全退出 Minecraft 后加载新版 Mod");
  return result;
}

export async function getVoiceStatus(window) {
  let result;
  try { result = await requestJson(window, "/voice", { timeoutMs: 8000, allowErrorBody: true }); }
  catch (error) { throw new Error(`无法检查语音接口：${error.message}；如尚未更新 Mod，请完全退出并重启 Minecraft`); }
  if (result.voiceBridgeVersion !== 2) throw new Error("语音接口版本过旧，请完全退出 Minecraft 后加载新版 Mod");
  return result;
}

export async function getInventory(window) {
  return requestJson(window, "/inventory", { timeoutMs: 8000 });
}

export async function getEnvironment(window) {
  return requestJson(window, "/environment", { timeoutMs: 8000 });
}

export async function scanBlocks(window, args = {}) {
  validateSchema(args, SCAN_BLOCKS_SCHEMA);
  const coordinates = ["x", "y", "z"].filter((key) => args[key] !== undefined);
  if (coordinates.length && coordinates.length !== 3) throw new Error("扫描中心必须同时提供 x、y、z");
  return requestJson(window, "/blocks/scan", { method: "POST", body: { radius: 8, maxResults: 32, ...args }, timeoutMs: 8000 });
}

/** Wait for a specific Mod operation, then return its observed terminal result.
 * Cancellation also stops the physical operation instead of only abandoning HTTP. */
async function runAtomicOperation(window, path, key, args, { signal, timeoutMs, onStarted, startPath = `${path}/start` } = {}) {
  if (signal?.aborted) throw new Error("操作已取消");
  let live;
  let operationId;
  let settled = false;
  let operationError;
  try {
    live = await requestJson(window, startPath, { method: "POST", body: args, timeoutMs: 8000 });
    const id = live?.[key]?.id;
    if (!id) throw new Error("Mod 未返回操作 ID，请更新并重启 Mod");
    operationId = id;
    await onStarted?.(live[key]);
    const deadline = Date.now() + timeoutMs;
    while (live[key]?.active) {
      if (signal?.aborted) throw new Error("操作已取消");
      if (Date.now() >= deadline) throw new Error("等待 Mod 操作结果超时");
      await delay(100, undefined, { signal });
      live = await requestJson(window, `${path}/status`, { timeoutMs: 8000 });
      if (live?.[key]?.id !== id) throw new Error("Mod 操作已被替换，停止等待");
    }
    settled = true;
    if (live[key]?.state !== "completed") return { ...live, ok: false, executionError: live[key]?.message || live[key]?.state || "操作失败" };
    return live;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (!settled && operationId) {
      const stopping = await stopAndWait(window, path, key, operationId);
      if (operationError && stopping?.[key]?.id === operationId) operationError.operationResult = stopping[key];
    }
  }
}

export function moveTo(window, args, options = {}) {
  validateSchema(args, MOVE_TO_SCHEMA);
  return runAtomicOperation(window, "/move", "move", { distance: 1, ...args }, { timeoutMs: 65_000, ...options });
}

export function breakBlock(window, args, options = {}) {
  validateSchema(args, BREAK_BLOCK_SCHEMA);
  return runAtomicOperation(window, "/blocks", "action", args, { timeoutMs: 25_000, ...options, startPath: "/blocks/break" });
}

export function placeBlock(window, args, options = {}) {
  validateSchema(args, PLACE_BLOCK_SCHEMA);
  return runAtomicOperation(window, "/blocks", "action", { face: "up", ...args }, { timeoutMs: 25_000, ...options, startPath: "/blocks/place" });
}

async function stopAndWait(window, path, key, operationId) {
  let stopping = await requestJson(window, `${path}/stop`, { method: "POST", body: { taskId: operationId }, timeoutMs: 8000 });
  // Crafting may need to wait for an outstanding server fill and recover materials.
  const cleanupDeadline = Date.now() + 6000;
  while (stopping?.[key]?.id === operationId && stopping[key].active && Date.now() < cleanupDeadline) {
    await delay(100);
    stopping = await requestJson(window, `${path}/status`, { timeoutMs: 8000 });
  }
  return stopping;
}

export function stopAtomicOperation(window, kind, operationId) {
  if (!["move", "block_action", "craft"].includes(kind) || typeof operationId !== "string"
      || !/^[0-9a-f-]{36}$/u.test(operationId)) throw new Error("原子操作类型或 ID 无效");
  return stopAndWait(window, kind === "move" ? "/move" : kind === "craft" ? "/craft" : "/blocks", kind === "block_action" ? "action" : kind, operationId);
}

export async function getCraftingRecipes(window, args) {
  validateSchema(args, RECIPES_SCHEMA);
  return requestJson(window, "/craft/recipes", { method: "POST", body: { quantity: 1, maxResults: 16, ...args }, timeoutMs: 8000 });
}

export function craftItem(window, args, options = {}) {
  validateSchema(args, CRAFT_SCHEMA);
  return runAtomicOperation(window, "/craft", "craft", { quantity: 1, ...args }, { timeoutMs: 70_000, ...options });
}

export async function getState(window) {
  return requestJson(window, "/state", { timeoutMs: 5000 });
}

export async function getObservation(window) {
  const results = await Promise.allSettled([
    getState(window),
    getEnvironment(window),
    getMiningStatus(window),
    getFollowStatus(window),
  ]);
  const [stateResult, environmentResult, miningResult, followResult] = results;
  const observation = {
    ok: true,
    observedAt: new Date().toISOString(),
    state: stateResult.status === "fulfilled" ? stateResult.value : null,
    environment: environmentResult.status === "fulfilled" ? environmentResult.value : null,
    mining: miningResult.status === "fulfilled" ? miningResult.value : null,
    follow: followResult.status === "fulfilled" ? followResult.value : null,
    errors: results
      .map((result, index) => result.status === "rejected" ? { source: ["state", "environment", "mining", "follow"][index], error: result.reason?.message || "request failed" } : null)
      .filter(Boolean),
  };
  const miningState = observation.mining?.mining?.state || observation.mining?.status;
  observation.activity = observation.state?.activity || (observation.follow?.follow?.active ? "following"
    : miningState && ["running", "equipping", "moving", "breaking", "waiting_target"].includes(miningState) ? "mining" : "unknown");
  observation.activityText = observation.state?.activityText || (observation.activity === "following" ? observation.follow.follow.message
    : observation.activity === "mining" ? "正在执行挖矿任务" : "当前活动未知");
  if (!observation.state && !observation.environment && !observation.mining && !observation.follow) {
    throw new Error("无法读取 Minecraft 当前状态");
  }
  return observation;
}

const DEFAULT_MINING_TARGETS = [
  "minecraft:coal_ore",
  "minecraft:iron_ore",
  "minecraft:copper_ore",
  "minecraft:gold_ore",
  "minecraft:diamond_ore",
  "minecraft:redstone_ore",
  "minecraft:lapis_ore",
  "minecraft:emerald_ore",
];

export function validateMiningPlan(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("挖矿参数格式无效");
  const strategy = String(raw.strategy ?? "ore").trim().toLowerCase();
  if (!["ore", "nearby"].includes(strategy)) throw new Error("第一阶段只支持 ore 或 nearby 模式");
  const targets = raw.targetBlocks === undefined ? DEFAULT_MINING_TARGETS : raw.targetBlocks;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) throw new Error("targetBlocks 必须包含 1 到 8 个方块 ID");
  const targetBlocks = [...new Set(targets.map((item) => String(item).trim().toLowerCase()))];
  if (targetBlocks.some((item) => !/^minecraft:[a-z0-9_./-]+$/u.test(item))) {
    throw new Error("targetBlocks 只能使用 minecraft 方块 ID");
  }
  const quantity = Number(raw.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 256) throw new Error("quantity 必须是 1 到 256 的整数");
  const maxMinutes = Number(raw.maxMinutes ?? 10);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 30) throw new Error("maxMinutes 必须在 0 到 30 分钟之间");
  const maxBlocks = Number(raw.maxBlocks ?? 256);
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 512) throw new Error("maxBlocks 必须是 1 到 512 的整数");
  return {
    strategy,
    targetBlocks,
    quantity,
    maxMinutes,
    maxBlocks,
    returnWhenFull: raw.returnWhenFull === true,
  };
}

export async function startMining(window, plan) {
  const validatedPlan = validateMiningPlan(plan);
  const inventory = await getInventory(window);
  const pickaxes = recognizeMiningPickaxes(inventory);
  if (!pickaxes.length) throw new Error("背包中没有可用的镐，无法开始自动挖矿");
  if (inventory.miningToolSelection !== "pickaxe_priority_v1") throw new Error("当前 Mod 尚不支持按优先级切换背包镐子，请更新 Mod 并重启 Minecraft");
  const result = await requestJson(window, "/mining/start", { method: "POST", body: validatedPlan, timeoutMs: 8000 });
  return { ...result, inventory, toolRecognition: { priority: PICKAXE_PRIORITY, pickaxes, preferred: pickaxes[0] } };
}

export async function getMiningStatus(window) {
  return requestJson(window, "/mining/status", { timeoutMs: 8000 });
}

export async function stopMining(window) {
  return requestJson(window, "/mining/stop", { method: "POST", body: {}, timeoutMs: 8000 });
}

export function validateFollowPlan(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("跟随参数格式无效");
  const plan = {};
  if (raw.targetUuid !== undefined) {
    if (typeof raw.targetUuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(raw.targetUuid)) throw new Error("targetUuid 必须是有效的玩家 UUID");
    plan.targetUuid = raw.targetUuid.toLowerCase();
  }
  if (raw.targetName !== undefined) {
    if (typeof raw.targetName !== "string" || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(raw.targetName)) throw new Error("targetName 必须是有效的玩家名称");
    plan.targetName = raw.targetName;
  }
  const distance = raw.followDistance === undefined ? 3 : raw.followDistance;
  if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 2 || distance > 6) throw new Error("followDistance 必须在 2 到 6 格之间");
  const minutes = raw.maxMinutes === undefined ? 10 : raw.maxMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0.01 || minutes > 30) throw new Error("maxMinutes 必须在 0.01 到 30 分钟之间");
  if (raw.ignoreSafety !== undefined && typeof raw.ignoreSafety !== "boolean") throw new Error("ignoreSafety 必须是布尔值");
  return raw.ignoreSafety === undefined
    ? { ...plan, followDistance: distance, maxMinutes: minutes }
    : { ...plan, followDistance: distance, maxMinutes: minutes, ignoreSafety: raw.ignoreSafety };
}

export async function getNearbyPlayers(window) {
  return requestJson(window, "/players", { timeoutMs: 8000 });
}

export async function startFollowing(window, plan) {
  return requestJson(window, "/follow/start", { method: "POST", body: validateFollowPlan(plan), timeoutMs: 8000 });
}

export async function getFollowStatus(window) {
  return requestJson(window, "/follow/status", { timeoutMs: 8000 });
}

export async function stopFollowing(window) {
  return requestJson(window, "/follow/stop", { method: "POST", body: {}, timeoutMs: 8000 });
}

export async function setFollowSafety(window, ignoreSafety) {
  if (typeof ignoreSafety !== "boolean") throw new Error("ignoreSafety 必须是布尔值");
  return requestJson(window, "/follow/safety", { method: "POST", body: { ignoreSafety }, timeoutMs: 8000 });
}
