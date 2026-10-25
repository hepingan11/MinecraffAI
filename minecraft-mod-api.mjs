import http from "node:http";
import { readdir, readFile } from "node:fs/promises";

const DEFAULT_REGISTRY_DIR = String.raw`G:\Game\[PCL启动器打包]RO26.2性能优化+生电轻量版 1.0.1\.minecraft\versions\[PCL启动器打包]RO26.2性能优化+生电轻量版\minecraft-ai\windows`;

export function getRegistryDir() {
  return process.env.MC_AI_REGISTRY_DIR?.trim() || DEFAULT_REGISTRY_DIR;
}

function requestJson(window, pathname, { method = "GET", body, timeoutMs = 4000 } = {}) {
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
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || value.ok === false) {
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

export async function getInventory(window) {
  return requestJson(window, "/inventory", { timeoutMs: 8000 });
}

export async function getEnvironment(window) {
  return requestJson(window, "/environment", { timeoutMs: 8000 });
}

export async function getState(window) {
  return requestJson(window, "/state", { timeoutMs: 5000 });
}

export async function getObservation(window) {
  const results = await Promise.allSettled([
    getState(window),
    getEnvironment(window),
    getMiningStatus(window),
  ]);
  const [stateResult, environmentResult, miningResult] = results;
  const observation = {
    ok: true,
    observedAt: new Date().toISOString(),
    state: stateResult.status === "fulfilled" ? stateResult.value : null,
    environment: environmentResult.status === "fulfilled" ? environmentResult.value : null,
    mining: miningResult.status === "fulfilled" ? miningResult.value : null,
    errors: results
      .map((result, index) => result.status === "rejected" ? { source: ["state", "environment", "mining"][index], error: result.reason?.message || "request failed" } : null)
      .filter(Boolean),
  };
  const miningState = observation.mining?.mining?.state || observation.mining?.status;
  observation.activity = observation.state?.activity || (miningState && ["running", "breaking", "waiting_target"].includes(miningState) ? "mining" : "unknown");
  observation.activityText = observation.state?.activityText || (observation.activity === "mining" ? "正在执行挖矿任务" : "当前活动未知");
  if (!observation.state && !observation.environment && !observation.mining) {
    throw new Error("无法读取 Minecraft 当前状态");
  }
  return observation;
}

const DEFAULT_MINING_TARGETS = ["minecraft:coal_ore", "minecraft:iron_ore"];

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
  return requestJson(window, "/mining/start", { method: "POST", body: validateMiningPlan(plan), timeoutMs: 8000 });
}

export async function getMiningStatus(window) {
  return requestJson(window, "/mining/status", { timeoutMs: 8000 });
}

export async function stopMining(window) {
  return requestJson(window, "/mining/stop", { method: "POST", body: {}, timeoutMs: 8000 });
}
