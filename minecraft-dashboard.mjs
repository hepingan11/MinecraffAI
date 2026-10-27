import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { discoverWindows, getEnvironment, getInventory, getMiningStatus, getObservation, getNearbyPlayers, getFollowStatus, setFollowSafety, getVoiceStatus, publicWindow, sendChat, startMining, stopMining, validateMessage, validateMiningPlan, validateFollowPlan } from "./minecraft-mod-api.mjs";
import { executeFollowCommand, followCommandFromChat } from "./follow-skill.mjs";
import { executeTeleportCommand, teleportCommandFromChat, validateTeleportPlan } from "./teleport-skill.mjs";
import { AutoReplyService } from "./auto-reply.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { ToolExecutor } from "./tool-executor.mjs";
import { registerAtomicTools } from "./minecraft-atomic-tools.mjs";
import { registerCraftingTools } from "./minecraft-crafting-tools.mjs";
import { exploreForOre, registerExplorationTools } from "./minecraft-exploration-tools.mjs";
import { stopAtomicOperation } from "./minecraft-mod-api.mjs";
import { EventQueue } from "./event-queue.mjs";
import { MinecraftEventSource } from "./minecraft-event-source.mjs";
import { TaskStateStore } from "./task-state.mjs";
import { KnowledgeBase, MAX_ENTRIES } from "./knowledge-base.mjs";
import { ExperienceStore, MAX_EXPERIENCES } from "./experience-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "web");
const PORT = Number.parseInt(process.env.MC_DASHBOARD_PORT ?? "3210", 10) || 3210;
const HOST = process.env.MC_DASHBOARD_HOST ?? "127.0.0.1";
const DEFAULT_LOG_PATH = String.raw`G:\Game\[PCL启动器打包]RO26.2性能优化+生电轻量版 1.0.1\.minecraft\versions\[PCL启动器打包]RO26.2性能优化+生电轻量版\logs\latest.log`;
const decoder = new TextDecoder("gb18030");
const knowledgeBase = new KnowledgeBase();
const experienceStore = new ExperienceStore();
const eventQueue = new EventQueue();
const taskState = new TaskStateStore();
const eventSource = new MinecraftEventSource({ queue: eventQueue });
const SKILL_NAMES = ["inventory", "environment", "observe", "mining", "explore_for_ore", "players", "follow", "teleport", "tasks", "scan_blocks", "move_to", "break_block", "place_block", "recipes", "craft"];
const SKILL_HEADINGS = {
  recipes: /^## 技能：minecraft_recipes\b/mu,
  craft: /^## 技能：minecraft_craft\b/mu,
  scan_blocks: /^## 技能：minecraft_scan_blocks\b/mu,
  move_to: /^## 技能：minecraft_move_to\b/mu,
  break_block: /^## 技能：minecraft_break_block\b/mu,
  place_block: /^## 技能：minecraft_place_block\b/mu,
  inventory: /^## 技能：minecraft_inventory\b/mu,
  environment: /^## 技能：minecraft_environment\b/mu,
  observe: /^## 技能：minecraft_observe\b/mu,
  mining: /^## 技能：minecraft_mining\b/mu,
  explore_for_ore: /^## 技能：minecraft_explore_for_ore\b/mu,
  players: /^## 技能：minecraft_players\b/mu,
  follow: /^## 技能：minecraft_players\b/mu,
  teleport: /^## 技能：minecraft_teleport\b/mu,
  tasks: /^## 统一事件与任务状态\s*$/mu,
};

async function readMinecraftSkill(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (!SKILL_NAMES.includes(normalized)) throw new Error(`未知 Minecraft 技能文档：${normalized || "(empty)"}`);
  const source = await readFile(path.join(ROOT, "skill.md"), "utf8");
  const match = SKILL_HEADINGS[normalized].exec(source);
  if (!match) throw new Error(`技能文档不存在：minecraft_${normalized}`);
  const rest = source.slice(match.index);
  const end = rest.indexOf("\n## 技能：");
  const content = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return { ok: true, skill: `minecraft_${normalized}`, content: content.slice(0, 12_000), truncated: content.length > 12_000 };
}

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

async function registerTask(kind, window, goal, result) {
  const live = result?.status?.mining || result?.status?.follow || result?.follow || result?.mining;
  if (result?.executionError || live?.active === false) return result;
  const task = await taskState.create({
    kind,
    windowId: window.id,
    goal,
    target: kind === "follow" ? { name: live?.targetName || goal.targetName || null, uuid: live?.targetUuid || goal.targetUuid || null } : { blocks: goal.targetBlocks || [] },
    params: goal,
    resumePolicy: "safe",
  });
  await taskState.markStarted(task.id);
  return { ...result, taskId: task.id, task: taskState.get(task.id) };
}

async function resumeMinecraftTask(task, window) {
  if (task.kind === "mining") return startMiningAndVerify(window, validateMiningPlan(task.params || task.goal));
  if (task.kind === "follow") return executeFollowCommand(window, { action: "start", ...validateFollowPlan(task.params || task.goal) });
  if (task.kind === "ore_exploration") {
    const requested = Number(task.params?.quantity ?? task.goal?.quantity ?? 1);
    const collected = Number(task.progress?.collected ?? 0);
    return exploreForOre(window, { ...(task.params || task.goal), quantity: Math.max(1, requested - collected) }, { taskState, existingTask: task });
  }
  throw new Error(`不支持续跑任务类型：${task.kind}`);
}

async function cancelMinecraftTask(task, window) {
  if (!task) throw new Error("任务不存在");
  if (String(task.windowId) !== String(window.id)) throw new Error("任务属于另一 Minecraft 窗口");
  if (["pending", "running", "paused", "interrupted"].includes(task.status)) {
    if (task.kind === "ore_exploration") {
      const active = activeExplorationTasks.get(task.id);
      if (active) active.cancelled = true;
      return taskState.cancel(task.id, "用户取消寻矿任务");
    }
    if (["move", "block_action", "craft"].includes(task.kind)) {
      const stopped = await stopAtomicOperation(window, task.kind, task.progress.operationId);
      const live = stopped[task.kind === "block_action" ? "action" : task.kind];
      if (!live || live.id !== task.progress.operationId || live.active) throw new Error("停止请求尚未确认，请再次观察任务状态");
      if (live.state !== "cancelled") return taskState.update(task.id, {
        status: live.state === "completed" ? "succeeded" : "failed", finishedAt: new Date().toISOString(),
        progress: { ...task.progress, ...live, operationId: live.id },
        failure: live.state === "completed" ? null : { failed: true, retryable: false, score: 0, reason: live.message },
      });
    }
  }
  return taskState.cancel(task.id);
}

const minecraftTools = new ToolRegistry();
const activeExplorationTasks = new Map();
registerAtomicTools(minecraftTools, { taskState });
registerCraftingTools(minecraftTools, { taskState });
registerExplorationTools(minecraftTools, { taskState, activeTasks: activeExplorationTasks });
minecraftTools
  .register({
    name: "minecraft_observe",
    description: "读取当前玩家、位置、环境和正在执行的 Minecraft 任务。需要实时事实时先调用此工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    handler: (_args, context) => getObservation(context.window),
  })
  .register({
    name: "minecraft_inventory",
    description: "读取当前玩家的非空背包槽位和物品状态。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    handler: (_args, context) => getInventory(context.window),
  })
  .register({
    name: "minecraft_environment",
    description: "读取当前位置、维度、玩家状态、附近实体和周边方块。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    handler: (_args, context) => getEnvironment(context.window),
  })
  .register({
    name: "minecraft_skill",
    description: "读取后端维护的 Minecraft 技能说明和参数边界；这是参考文档，不会直接执行游戏动作。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: SKILL_NAMES.map((name) => `minecraft_${name}`) } },
      required: ["name"],
      additionalProperties: false,
    },
    readOnly: true,
    handler: (args) => readMinecraftSkill(args.name.replace(/^minecraft_/u, "")),
  })
  .register({
    name: "minecraft_mining",
    description: "开始、查询或停止受后端限制的挖矿任务。开始前必须提供明确的目标或使用 nearby 模式。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "stop"], description: "默认 start" },
        strategy: { type: "string", enum: ["ore", "nearby"] },
        targetBlocks: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", pattern: "^minecraft:[a-z0-9_./-]+$" } },
        quantity: { type: "integer", minimum: 1, maximum: 256 },
        maxMinutes: { type: "number", exclusiveMinimum: 0, maximum: 30 },
        maxBlocks: { type: "integer", minimum: 1, maximum: 512 },
        returnWhenFull: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const action = args.action || "start";
      if (action === "status") return { ...(await getMiningStatus(context.window)), tasks: taskState.list({ windowId: context.window.id, kind: "mining" }) };
      if (action === "stop") {
        const result = await stopMining(context.window);
        await taskState.cancelActive({ windowId: context.window.id, kind: "mining" });
        return result;
      }
      const plan = validateMiningPlan({ ...args, action: undefined });
      return registerTask("mining", context.window, plan, await startMiningAndVerify(context.window, plan));
    },
  })
  .register({
    name: "minecraft_players",
    description: "识别 32 格内可跟随的其他玩家，并按距离返回。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    handler: (_args, context) => getNearbyPlayers(context.window),
  })
  .register({
    name: "minecraft_follow",
    description: "开始、查询、停止跟随或设置跟随安全模式。所有目标和距离参数由后端再次校验。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "stop", "safety"] },
        target: { type: "string", enum: ["nearest", "sender"] },
        targetName: { type: "string", pattern: "^[\\p{L}\\p{N}_.-]{1,64}$" },
        targetUuid: { type: "string", pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$" },
        followDistance: { type: "number", minimum: 2, maximum: 6 },
        maxMinutes: { type: "number", exclusiveMinimum: 0, maximum: 30 },
        ignoreSafety: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const action = args.action || "start";
      if (action === "status") return { ...(await getFollowStatus(context.window)), tasks: taskState.list({ windowId: context.window.id, kind: "follow" }) };
      if (action === "stop") {
        const result = await executeFollowCommand(context.window, { action: "stop" });
        await taskState.cancelActive({ windowId: context.window.id, kind: "follow" });
        return result;
      }
      if (action === "safety") return setFollowSafety(context.window, args.ignoreSafety === true);
      const command = { action: "start" };
      if (args.targetName !== undefined) command.targetName = args.targetName;
      if (args.targetUuid !== undefined) command.targetUuid = args.targetUuid;
      if (args.target === "sender") {
        const parsed = followCommandFromChat(context.chatText);
        if (!parsed || parsed.action !== "start") throw new Error("无法从当前聊天确认要跟随的发送者");
        Object.assign(command, parsed);
      } else if (args.target !== "nearest" && !args.targetName && !args.targetUuid) {
        command.target = "nearest";
      }
      if (args.followDistance !== undefined) command.followDistance = args.followDistance;
      if (args.maxMinutes !== undefined) command.maxMinutes = args.maxMinutes;
      if (args.ignoreSafety !== undefined) command.ignoreSafety = args.ignoreSafety;
      validateFollowPlan(command);
      return registerTask("follow", context.window, command, await executeFollowCommand(context.window, command));
    },
  })
  .register({
    name: "minecraft_tasks",
    description: "读取通用任务状态、失败评估，并按后端策略续跑或取消任务。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "status", "resume", "cancel"] },
        taskId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
      },
      additionalProperties: false,
    },
    readOnly: false,
    handler: async (args, context) => {
      const action = args.action || "list";
      if (action === "list") return taskState.state();
      if (!args.taskId) throw new Error("该任务操作必须提供 taskId");
      if (action === "status") return taskState.get(args.taskId) || { ok: false, executionError: "任务不存在" };
      const current = taskState.get(args.taskId);
      if (!current) throw new Error("任务不存在");
      if (current.windowId && String(current.windowId) !== String(context.window.id)) throw new Error("任务属于另一 Minecraft 窗口，拒绝跨窗口续跑");
      if (action === "cancel") return cancelMinecraftTask(current, context.window);
      return taskState.resume(args.taskId, (task) => resumeMinecraftTask(task, context.window));
    },
  })
  .register({
    name: "minecraft_teleport",
    description: "向当前聊天发送者发送传送请求。目标身份只由后端从真实聊天前缀解析。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    handler: (args, context) => {
      if (Object.keys(args).length) throw new Error("传送工具不接受目标 ID，目标必须来自当前聊天发送者");
      const command = teleportCommandFromChat(context.chatText, context.triggerName);
      if (!command || command.action !== "request") throw new Error("当前消息不是向聊天发送者发起传送请求");
      validateTeleportPlan(command);
      return executeTeleportCommand(context.window, command);
    },
  });

const toolExecutor = new ToolExecutor({ registry: minecraftTools });

const autoReply = new AutoReplyService({
  getLogPath: () => process.env.MC_LOG_PATH ?? DEFAULT_LOG_PATH,
  knowledgeBase,
  experienceStore,
  toolRegistry: minecraftTools,
  eventQueue,
  eventSource,
  taskState,
  toolExecutor,
  skillExecutor: async (skill, window, chatText) => {
    if (skill === "minecraft_observe") return getObservation(window);
    if (skill === "minecraft_inventory") return getInventory(window);
    if (skill === "minecraft_environment") return getEnvironment(window);
    if (skill === "minecraft_mining") return startMiningAndVerify(window, miningPlanFromChat(chatText));
    if (skill === "minecraft_follow") {
      const command = followCommandFromChat(chatText);
      if (!command) throw new Error("未识别到明确的跟随指令");
      return executeFollowCommand(window, command);
    }
    if (skill === "minecraft_teleport") {
      const command = teleportCommandFromChat(chatText, autoReply.config.triggerName);
      if (!command) throw new Error("未识别到明确的传送指令");
      return executeTeleportCommand(window, command);
    }
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
      }, {
        name: "minecraft_explore_for_ore",
        description: "分阶段扫描已加载区域，安全导航、重新验证并挖掘矿物；不足时继续步行探索新区域",
        method: "POST",
        endpoint: "/api/skills/minecraft_explore_for_ore",
        readOnly: false,
      }, {
        name: "minecraft_players",
        description: "识别 32 格内可跟随的其他玩家，按距离排序",
        method: "GET",
        endpoint: "/api/skills/minecraft_players",
        readOnly: true,
      }, {
        name: "minecraft_follow",
        description: "先识别附近玩家，再选择一位并锁定 UUID 持续跟随；支持查询和停止",
        method: "POST/GET",
        endpoint: "/api/skills/minecraft_follow",
        readOnly: false,
      }, {
        name: "minecraft_teleport",
        description: "从聊天发送者中解析玩家 ID，并向该玩家发送 /tpa 请求",
        method: "POST",
        endpoint: "/api/skills/minecraft_teleport",
        readOnly: false,
      }, {
        name: "minecraft_tasks",
        description: "读取统一任务状态、失败评估并续跑或取消任务",
        method: "POST",
        endpoint: "/api/tasks",
        readOnly: false,
      }, ...["minecraft_recipes", "minecraft_craft"].map((name) => ({
        name, description: minecraftTools.get(name).description,
        method: "POST", endpoint: `/api/skills/${name}`, readOnly: minecraftTools.get(name).readOnly,
      }))],
    });
  }

  // Numen-style public tool book: schemas are exposed, handlers stay backend-only.
  if (req.method === "GET" && url.pathname === "/api/tools") {
    return json(res, 200, {
      ok: true,
      tools: minecraftTools.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        readOnly: tool.readOnly,
      })),
      executor: {
        busy: toolExecutor.busy,
        current: toolExecutor.current()?.id || null,
        outstanding: toolExecutor.outstanding(),
      },
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
      experiences: { ...experienceStore.stats(), maxEntries: MAX_EXPERIENCES },
      ...(windowError ? { windowError } : {}),
      now: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/automation/config") {
    return json(res, 200, { ok: true, ...(await autoReply.getPublicState()) });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    return json(res, 200, { ok: true, events: eventQueue.recent(validateLimit(url.searchParams.get("limit"))), pending: eventQueue.peek(), queue: eventQueue.state() });
  }

  if (url.pathname === "/api/tasks") {
    try {
      if (req.method === "GET") return json(res, 200, { ok: true, ...taskState.state() });
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "任务接口只支持 GET 或 POST" });
      const body = await readBody(req);
      const action = body?.action || "list";
      if (action === "list") return json(res, 200, { ok: true, ...taskState.state() });
      if (typeof body?.taskId !== "string" || !body.taskId.trim()) throw new Error("任务操作必须提供 taskId");
      if (action === "status") return json(res, 200, { ok: true, task: taskState.get(body.taskId) });
      if (action === "cancel") {
        const task = taskState.get(body.taskId);
        if (!task) throw new Error("任务不存在");
        const selected = await selectMinecraftWindow(body.windowId || task.windowId);
        return json(res, 200, { ok: true, task: await cancelMinecraftTask(task, selected) });
      }
      if (action === "resume") {
        const task = taskState.get(body.taskId);
        if (!task) throw new Error("任务不存在");
        const selected = await selectMinecraftWindow(body.windowId || task.windowId);
        return json(res, 200, { ok: true, ...(await taskState.resume(body.taskId, (item) => resumeMinecraftTask(item, selected))) });
      }
      throw new Error("不支持的任务操作");
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  if (req.method === "GET" && url.pathname === "/api/voice/status") {
    try {
      const selected = await selectMinecraftWindow(url.searchParams.get("windowId") || autoReply.config.windowId || undefined);
      return json(res, 200, { ok: true, windowId: selected.id, voice: await getVoiceStatus(selected) });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
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

  if (url.pathname === "/api/experiences" || url.pathname === "/api/experiences/feedback") {
    if (url.pathname === "/api/experiences" && req.method === "GET") {
      try {
        const status = url.searchParams.get("status") || undefined;
        const limit = validateLimit(url.searchParams.get("limit"));
        return json(res, 200, { ok: true, entries: experienceStore.list({ status, limit }), ...experienceStore.stats(), maxEntries: MAX_EXPERIENCES });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === "/api/experiences" && (req.method === "POST" || req.method === "PUT")) {
      try {
        const body = await readBody(req);
        const entry = await experienceStore.upsert({ ...body, source: body?.source || "manual", status: "pending" });
        return json(res, 200, { ok: true, entry, entries: experienceStore.list(), ...experienceStore.stats(), maxEntries: MAX_EXPERIENCES });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === "/api/experiences" && req.method === "DELETE") {
      try {
        const entry = await experienceStore.remove(url.searchParams.get("id"));
        return json(res, 200, { ok: true, entry, entries: experienceStore.list(), ...experienceStore.stats(), maxEntries: MAX_EXPERIENCES });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === "/api/experiences/feedback" && req.method === "POST") {
      try {
        const entry = await experienceStore.applyFeedback(await readBody(req));
        return json(res, 200, { ok: true, entry, ...experienceStore.stats() });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
  }

  const experienceIdPath = url.pathname.match(/^\/api\/experiences\/([^/]+)$/u);
  if (experienceIdPath && (req.method === "PUT" || req.method === "DELETE")) {
    try {
      const id = decodeURIComponent(experienceIdPath[1]);
      if (req.method === "DELETE") {
        const entry = await experienceStore.remove(id);
        return json(res, 200, { ok: true, entry, entries: experienceStore.list(), ...experienceStore.stats(), maxEntries: MAX_EXPERIENCES });
      }
      const body = await readBody(req);
      const entry = await experienceStore.upsert({ ...body, id, source: body?.source || "manual", status: "pending" });
      return json(res, 200, { ok: true, entry, entries: experienceStore.list(), ...experienceStore.stats(), maxEntries: MAX_EXPERIENCES });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  const experienceAction = url.pathname.match(/^\/api\/experiences\/([^/]+)\/(approve|reject)$/u);
  if (experienceAction && req.method === "POST") {
    try {
      const entry = await experienceStore.setStatus(decodeURIComponent(experienceAction[1]), experienceAction[2] === "approve" ? "approved" : "disabled");
      return json(res, 200, { ok: true, entry, ...experienceStore.stats() });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
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

  if (req.method === "GET" && url.pathname === "/api/skills/minecraft_players") {
    try {
      const selected = await selectMinecraftWindow(url.searchParams.get("windowId"));
      return json(res, 200, { ok: true, skill: "minecraft_players", windowId: selected.id, result: await getNearbyPlayers(selected) });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  if (url.pathname === "/api/skills/minecraft_follow" || url.pathname === "/api/skills/minecraft_follow/stop" || url.pathname === "/api/skills/minecraft_follow/safety") {
    try {
      const stopping = url.pathname.endsWith("/stop");
      const safety = url.pathname.endsWith("/safety");
      if ((stopping || safety) && req.method !== "POST") return json(res, 405, { ok: false, error: "跟随技能查询使用 GET，开始、停止和安全模式切换使用 POST" });
      if (!safety && !["GET", "POST"].includes(req.method)) return json(res, 405, { ok: false, error: "跟随技能查询使用 GET，开始和停止使用 POST" });
      const body = req.method === "POST" ? await readBody(req) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("跟随参数格式无效");
      const plan = req.method === "POST" && !stopping && !safety ? validateFollowPlan(body) : null;
      const selected = await selectMinecraftWindow(body.windowId ?? url.searchParams.get("windowId"));
      const result = safety ? await setFollowSafety(selected, body.ignoreSafety)
        : stopping ? await executeFollowCommand(selected, { action: "stop" })
          : req.method === "GET" ? await getFollowStatus(selected) : await executeFollowCommand(selected, { ...plan, action: "start" });
      if (stopping) {
        autoReply.stopFollowMonitor(selected.id);
        await taskState.cancelActive({ windowId: selected.id, kind: "follow" });
      }
      else if (!safety && req.method === "POST" && result?.follow?.active === true) autoReply.startFollowMonitor(selected, result);
      const tracked = !safety && !stopping && req.method === "POST" ? await registerTask("follow", selected, plan, result) : result;
      return json(res, 200, { ok: true, skill: "minecraft_follow", action: safety ? "safety" : stopping ? "stop" : req.method === "GET" ? "status" : "start", windowId: selected.id, result: tracked });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  if (url.pathname === "/api/skills/minecraft_teleport") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "传送技能只支持 POST" });
    try {
      const body = await readBody(req);
      const selected = await selectMinecraftWindow(body.windowId);
      const plan = validateTeleportPlan(body);
      const result = await executeTeleportCommand(selected, { action: "request", ...plan });
      return json(res, 200, { ok: true, skill: "minecraft_teleport", action: "request", windowId: selected.id, result });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  if (url.pathname === "/api/skills/minecraft_mining" || url.pathname === "/api/skills/minecraft_mining/stop") {
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const selected = await selectMinecraftWindow(body.windowId ?? url.searchParams.get("windowId"));
      if (url.pathname.endsWith("/stop")) {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "停止挖矿只支持 POST" });
        const result = await stopMining(selected);
        await taskState.cancelActive({ windowId: selected.id, kind: "mining" });
        return json(res, 200, { ok: true, skill: "minecraft_mining", action: "stop", windowId: selected.id, result });
      }
      if (req.method === "GET") {
        const result = await getMiningStatus(selected);
        return json(res, 200, { ok: true, skill: "minecraft_mining", action: "status", windowId: selected.id, result });
      }
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "挖矿技能只支持 GET 或 POST" });
      const plan = validateMiningPlan(body);
      const result = await registerTask("mining", selected, plan, await startMining(selected, plan));
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

  const atomicSkill = url.pathname.match(/^\/api\/skills\/(minecraft_(?:scan_blocks|move_to|break_block|place_block|recipes|craft|explore_for_ore))$/u);
  if (atomicSkill) {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "原子动作接口只支持 POST" });
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort("客户端已断开"); };
    res.on("close", disconnected);
    try {
      const { windowId, ...args } = await readBody(req);
      const selected = await selectMinecraftWindow(windowId);
      const result = await minecraftTools.invoke(atomicSkill[1], args, { window: selected, signal: controller.signal });
      return json(res, result.ok === false ? 400 : 200, { ...result, windowId: selected.id });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    finally { res.off("close", disconnected); }
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

Promise.all([knowledgeBase.load(), experienceStore.load(), taskState.load()]).catch((error) => {
  autoReply.status.lastError = error.message;
  console.error(`Minecraft AI persistent store startup failed: ${error.message}`);
}).then(() => autoReply.start()).catch((error) => {
  autoReply.status.lastError = error.message;
  console.error(`Minecraft AI auto-reply startup failed: ${error.message}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Minecraft AI 控制台：http://${HOST}:${PORT}`);
});
