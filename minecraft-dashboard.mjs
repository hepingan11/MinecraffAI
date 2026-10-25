import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { discoverWindows, getEnvironment, getInventory, getMiningStatus, getObservation, publicWindow, sendChat, startMining, stopMining, validateMessage, validateMiningPlan } from "./minecraft-mod-api.mjs";
import { AutoReplyService } from "./auto-reply.mjs";
import { KnowledgeBase, MAX_ENTRIES } from "./knowledge-base.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "web");
const PORT = Number.parseInt(process.env.MC_DASHBOARD_PORT ?? "3210", 10) || 3210;
const HOST = process.env.MC_DASHBOARD_HOST ?? "127.0.0.1";
const DEFAULT_LOG_PATH = String.raw`G:\Game\[PCL启动器打包]RO26.2性能优化+生电轻量版 1.0.1\.minecraft\versions\[PCL启动器打包]RO26.2性能优化+生电轻量版\logs\latest.log`;
const decoder = new TextDecoder("gb18030");
const knowledgeBase = new KnowledgeBase();

function miningPlanFromChat(text) {
  const source = String(text ?? "").replace(/@[^\s]+/u, " ");
  const targetBlocks = [];
  if (/铁/iu.test(source)) targetBlocks.push("minecraft:iron_ore");
  if (/煤/iu.test(source)) targetBlocks.push("minecraft:coal_ore");
  if (/铜/iu.test(source)) targetBlocks.push("minecraft:copper_ore");
  if (/金/iu.test(source)) targetBlocks.push("minecraft:gold_ore");
  if (/钻石|钻石矿/iu.test(source)) targetBlocks.push("minecraft:diamond_ore");
  const quantityMatch = source.match(/(\d{1,3})\s*(?:个|块|枚)?/u);
  const minutesMatch = source.match(/(\d{1,2})\s*分钟/u);
  const quantity = Math.min(Math.max(Number(quantityMatch?.[1] ?? 8), 1), 256);
  return {
    strategy: "ore",
    targetBlocks: targetBlocks.length ? targetBlocks : undefined,
    quantity,
    maxMinutes: Math.min(Math.max(Number(minutesMatch?.[1] ?? 10), 1), 30),
    maxBlocks: Math.min(Math.max(quantity * 8, 32), 512),
    returnWhenFull: /背包.*满|满.*背包/iu.test(source),
  };
}

async function startMiningAndVerify(window, plan) {
  const started = await startMining(window, plan);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const status = await getMiningStatus(window);
  const task = status?.mining;
  if (task && ["safety_stop", "error"].includes(task.state)) {
    return { started, status, executionError: task.message || task.state };
  }
  return { started, status };
}

const autoReply = new AutoReplyService({
  getLogPath: () => process.env.MC_LOG_PATH ?? DEFAULT_LOG_PATH,
  knowledgeBase,
  skillExecutor: async (skill, window, chatText) => {
    if (skill === "minecraft_observe") return getObservation(window);
    if (skill === "minecraft_inventory") return getInventory(window);
    if (skill === "minecraft_environment") return getEnvironment(window);
    if (skill === "minecraft_mining") return startMiningAndVerify(window, miningPlanFromChat(chatText));
    throw new Error(`未知技能：${skill}`);
  },
});

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function validateLimit(value) {
  const parsed = Number.parseInt(value ?? "20", 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 20, 1), 200);
}

async function readChat(logPath, count) {
  const bytes = await readFile(logPath);
  const text = decoder.decode(bytes);
  return text.split(/\r?\n/)
    .filter((line) => line.includes("[CHAT]"))
    .slice(-count)
    .map((line) => {
      const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\].*?\[CHAT\]\s*(.*)$/);
      return match ? { time: match[1], text: match[2] } : { text: line };
    });
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求必须是有效的 JSON");
  }
}

function validateWindowId(value) {
  if (value === undefined || value === null) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new Error("窗口标识无效");
  }
  const normalized = String(value).trim();
  if (normalized.length > 200) throw new Error("窗口标识无效");
  return normalized;
}

async function selectMinecraftWindow(value) {
  const requestedWindowId = validateWindowId(value);
  const windows = await discoverWindows();
  if (!windows.length) throw new Error("未检测到 Minecraft 窗口");
  if (windows.length > 1 && !requestedWindowId) throw new Error("检测到多个 Minecraft 窗口，请指定 windowId");
  const selected = requestedWindowId ? windows.find((window) => window.id === requestedWindowId) : windows[0];
  if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
  return selected;
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/windows") {
    try {
      return json(res, 200, { ok: true, windows: (await discoverWindows()).map(publicWindow) });
    } catch (error) {
      return json(res, 503, { ok: false, error: "无法获取 Minecraft 窗口列表", detail: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    return json(res, 200, {
      ok: true,
      skills: [{
        name: "minecraft_inventory",
        description: "读取指定 Minecraft 客户端当前玩家的非空背包槽位",
        method: "GET",
        endpoint: "/api/skills/minecraft_inventory",
        readOnly: true,
      }, {
        name: "minecraft_environment",
        description: "读取玩家位置、维度、状态、附近实体和周边方块",
        method: "GET",
        endpoint: "/api/skills/minecraft_environment",
        readOnly: true,
      }, {
        name: "minecraft_observe",
        description: "聚合读取玩家当前行为、位置、环境和正在执行的任务",
        method: "GET",
        endpoint: "/api/skills/minecraft_observe",
        readOnly: true,
      }, {
        name: "minecraft_mining",
        description: "在后端限制的时间、数量和目标方块范围内执行第一阶段有限挖矿任务",
        method: "POST/GET",
        endpoint: "/api/skills/minecraft_mining",
        readOnly: false,
      }],
    });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const logPath = process.env.MC_LOG_PATH ?? DEFAULT_LOG_PATH;
    let logAvailable = false;
    try { await stat(logPath); logAvailable = true; } catch { /* report unavailable */ }
    let windows = [];
    let bridgeAvailable = false;
    let windowError;
    try {
      windows = await discoverWindows();
      bridgeAvailable = windows.length > 0;
    } catch (error) {
      bridgeAvailable = false;
      windowError = error.message;
    }
    return json(res, 200, {
      ok: true,
      service: "Minecraft AI 控制台",
      logAvailable,
      logPath,
      bridgeAvailable,
      directApiAvailable: bridgeAvailable,
      windows: windows.map(publicWindow),
      transport: "fabric-mod",
      automation: await autoReply.getPublicState(),
      knowledgeBase: { ...knowledgeBase.stats(), maxEntries: MAX_ENTRIES },
      ...(windowError ? { windowError } : {}),
      now: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/automation/config") {
    return json(res, 200, { ok: true, ...(await autoReply.getPublicState()) });
  }

  if (req.method === "PUT" && url.pathname === "/api/automation/config") {
    try {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...(await autoReply.update(body)) });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/knowledge-base") {
    if (req.method === "GET") {
      return json(res, 200, { ok: true, entries: knowledgeBase.list(), ...knowledgeBase.stats(), maxEntries: MAX_ENTRIES });
    }
    if (req.method === "POST" || req.method === "PUT") {
      try {
        const entry = await knowledgeBase.upsert(await readBody(req));
        return json(res, 200, { ok: true, entry, entries: knowledgeBase.list(), ...knowledgeBase.stats(), maxEntries: MAX_ENTRIES });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === "DELETE") {
      try {
        const entry = await knowledgeBase.remove(url.searchParams.get("id"));
        return json(res, 200, { ok: true, entry, entries: knowledgeBase.list(), ...knowledgeBase.stats(), maxEntries: MAX_ENTRIES });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/skills/minecraft_inventory") {
    try {
      const requestedWindowId = validateWindowId(url.searchParams.get("windowId"));
      const windows = await discoverWindows();
      if (!windows.length) throw new Error("未检测到 Minecraft 窗口");
      if (windows.length > 1 && !requestedWindowId) throw new Error("检测到多个 Minecraft 窗口，请指定 windowId");
      const selected = requestedWindowId ? windows.find((window) => window.id === requestedWindowId) : windows[0];
      if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
      const inventory = await getInventory(selected);
      return json(res, 200, { ok: true, skill: "minecraft_inventory", windowId: selected.id, inventory });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/skills/minecraft_environment") {
    try {
      const requestedWindowId = validateWindowId(url.searchParams.get("windowId"));
      const windows = await discoverWindows();
      if (!windows.length) throw new Error("未检测到 Minecraft 窗口");
      if (windows.length > 1 && !requestedWindowId) throw new Error("检测到多个 Minecraft 窗口，请指定 windowId");
      const selected = requestedWindowId ? windows.find((window) => window.id === requestedWindowId) : windows[0];
      if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
      const environment = await getEnvironment(selected);
      return json(res, 200, { ok: true, skill: "minecraft_environment", windowId: selected.id, environment });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/skills/minecraft_observe") {
    try {
      const selected = await selectMinecraftWindow(url.searchParams.get("windowId"));
      const observation = await getObservation(selected);
      return json(res, 200, { ok: true, skill: "minecraft_observe", windowId: selected.id, observation });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/skills/minecraft_mining" || url.pathname === "/api/skills/minecraft_mining/stop") {
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const selected = await selectMinecraftWindow(body.windowId ?? url.searchParams.get("windowId"));
      if (url.pathname.endsWith("/stop")) {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "停止挖矿只支持 POST" });
        const result = await stopMining(selected);
        return json(res, 200, { ok: true, skill: "minecraft_mining", action: "stop", windowId: selected.id, result });
      }
      if (req.method === "GET") {
        const result = await getMiningStatus(selected);
        return json(res, 200, { ok: true, skill: "minecraft_mining", action: "status", windowId: selected.id, result });
      }
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "挖矿技能只支持 GET 或 POST" });
      const plan = validateMiningPlan(body);
      const result = await startMining(selected, plan);
      return json(res, 200, { ok: true, skill: "minecraft_mining", action: "start", windowId: selected.id, plan, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/chat") {
    const logPath = process.env.MC_LOG_PATH ?? DEFAULT_LOG_PATH;
    try {
      const messages = await readChat(logPath, validateLimit(url.searchParams.get("limit")));
      return json(res, 200, { ok: true, messages });
    } catch (error) {
      return json(res, 503, { ok: false, error: "暂时无法读取游戏日志", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/message") {
    try {
      const body = await readBody(req);
      const message = validateMessage(body?.message);
      const requestedWindowId = validateWindowId(body?.windowId);
      const windows = await discoverWindows();
      if (windows.length === 0) throw new Error("未检测到 Minecraft 窗口");
      if (windows.length > 1 && !requestedWindowId) {
        throw new Error("检测到多个 Minecraft 窗口，请先选择操作窗口");
      }
      const selected = requestedWindowId
        ? windows.find((window) => String(window.id) === requestedWindowId)
        : windows[0];
      if (!selected) throw new Error("所选 Minecraft 窗口已不存在，请重新选择");
      const result = await sendChat(selected, message);
      return json(res, 200, { ok: true, message, windowId: selected.id, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  return json(res, 404, { ok: false, error: "接口不存在" });
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(req, res, url) {
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return json(res, 403, { ok: false, error: "禁止访问" });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    json(res, 404, { ok: false, error: "页面不存在" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

knowledgeBase.load().catch((error) => {
  autoReply.status.lastError = error.message;
  console.error(`Minecraft AI knowledge base startup failed: ${error.message}`);
}).then(() => autoReply.start()).catch((error) => {
  autoReply.status.lastError = error.message;
  console.error(`Minecraft AI auto-reply startup failed: ${error.message}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Minecraft AI 控制台：http://${HOST}:${PORT}`);
});
