import { getInventory, startBlueprintBuild } from "../minecraft/minecraft-mod-api.mjs";
import { listLitematicNames, readLitematic } from "./litematic-blueprint.mjs";
import { registerOperationTool } from "./minecraft-operation-tool.mjs";

const POSITION_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
    y: { type: "integer", minimum: -64, maximum: 320 },
    z: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
  },
  required: ["x", "y", "z"],
  additionalProperties: false,
};
const BUILD_SCHEMA = {
  type: "object",
  properties: {
    // 文件名允许中文等 Unicode 字母/数字，路径分隔符仍然不在允许字符内。
    name: { type: "string", minLength: 1, maxLength: 128, pattern: "^[\\p{L}\\p{N}][\\p{L}\\p{N}_.-]*(?:\\.litematic)?$" },
    origin: POSITION_SCHEMA,
    rotation: { type: "integer", enum: [0, 90, 180, 270] },
    dimension: { type: "string", pattern: "^[a-z0-9_.-]+:[a-z0-9_./-]+$", maxLength: 128 },
    maxBlocks: { type: "integer", minimum: 1, maximum: 100_000 },
    maxMinutes: { type: "number", exclusiveMinimum: 0, maximum: 15 },
    allowPartial: { type: "boolean" },
    allowBreaking: { type: "boolean" },
  },
  required: ["name", "origin", "dimension"],
  additionalProperties: false,
};

const DIRECTIONS = [
  ["up", 0, 1, 0],
  ["down", 0, -1, 0],
  ["north", 0, 0, -1],
  ["south", 0, 0, 1],
  ["west", -1, 0, 0],
  ["east", 1, 0, 0],
];
const ATTACHED = new Set([
  "minecraft:torch", "minecraft:redstone_torch", "minecraft:soul_torch", "minecraft:ladder",
  "minecraft:oak_sign", "minecraft:spruce_sign", "minecraft:birch_sign", "minecraft:jungle_sign",
  "minecraft:acacia_sign", "minecraft:dark_oak_sign", "minecraft:mangrove_sign", "minecraft:cherry_sign",
  "minecraft:oak_wall_sign", "minecraft:spruce_wall_sign", "minecraft:birch_wall_sign", "minecraft:jungle_wall_sign",
  "minecraft:acacia_wall_sign", "minecraft:dark_oak_wall_sign", "minecraft:mangrove_wall_sign", "minecraft:cherry_wall_sign",
  "minecraft:rail", "minecraft:carpet", "minecraft:short_grass", "minecraft:grass", "minecraft:fern",
  "minecraft:dandelion", "minecraft:poppy", "minecraft:blue_orchid", "minecraft:allium", "minecraft:azure_bluet",
  "minecraft:red_tulip", "minecraft:orange_tulip", "minecraft:white_tulip", "minecraft:pink_tulip", "minecraft:oxeye_daisy",
]);
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

function key(pos) { return `${pos.x},${pos.y},${pos.z}`; }
function itemId(blockId) { return String(blockId).split("[", 1)[0]; }
function isAir(blockId) { return AIR.has(String(blockId)); }
function isAttached(blockId) {
  const id = itemId(blockId);
  return ATTACHED.has(id) || /(?:_wall_torch|_wall_sign|_button|_pressure_plate|_rail|_carpet|_lantern|_flower|_sapling|_mushroom|_fungus|_trapdoor|_lever)$/u.test(id);
}
function samePosition(a, b) { return a.x === b.x && a.y === b.y && a.z === b.z; }
function adjacent(pos, direction) { return { x: pos.x + direction[1], y: pos.y + direction[2], z: pos.z + direction[3] }; }

function inventoryMaterials(inventory) {
  const counts = new Map();
  for (const entry of inventory?.items || []) {
    const id = String(entry.itemId || "");
    const count = Number(entry.count || 0);
    if (id && Number.isFinite(count)) counts.set(id, (counts.get(id) || 0) + count);
  }
  return counts;
}

function missingMaterials(needed, inventory) {
  const have = inventoryMaterials(inventory);
  return Object.fromEntries(Object.entries(needed)
    .map(([id, count]) => [id, Math.max(0, count - (have.get(id) || 0))])
    .filter(([, count]) => count > 0));
}

async function inspectAll(window, dimension, positions, signal) {
  const map = new Map();
  for (let index = 0; index < positions.length; index += 256) {
    if (signal?.aborted) throw new Error("建造已取消");
    const batch = positions.slice(index, index + 256);
    const result = await inspectBlocks(window, { dimension, positions: batch }, { timeoutMs: 15_000 });
    for (const block of result.blocks || []) map.set(key(block.position), block);
  }
  return map;
}

function chooseFace(target, world) {
  for (const direction of DIRECTIONS) {
    const support = world.get(key(adjacent(target, direction)));
    if (support && support.loaded && !support.air && !support.replaceable) return direction[0];
  }
  return null;
}

function sortedTargets(targets) {
  return [...targets].sort((a, b) => Number(isAttached(a.blockId)) - Number(isAttached(b.blockId)
    || a.y - b.y || a.z - b.z || a.x - b.x));
}

async function moveToTarget(window, target, dimension, signal) {
  // The Mod deliberately caps one move request at 32 blocks. Walk in short
  // verified hops so a large blueprint can load nearby chunks like a player.
  for (let hop = 0; hop < 128; hop += 1) {
    if (signal?.aborted) throw new Error("建造已取消");
    const environment = await getEnvironment(window);
    const position = environment?.position;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) throw new Error("无法读取当前位置，不能继续建造");
    const dx = target.x + 0.5 - position.x;
    const dz = target.z + 0.5 - position.z;
    const dy = target.y - position.y;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal <= 20 && Math.abs(dy) <= 12) {
      const result = await moveTo(window, { x: target.x, y: target.y, z: target.z, dimension, distance: 2.5 }, { signal });
      if (result.ok === false) throw new Error(result.executionError || "前往蓝图目标失败");
      return result;
    }
    const scale = Math.min(18, Math.max(6, horizontal / 2));
    const length = Math.max(horizontal, 1);
    const step = {
      x: Math.round(position.x + (dx / length) * scale - 0.5),
      y: Math.round(Math.max(-64, Math.min(320, position.y + Math.max(-6, Math.min(6, dy))))),
      z: Math.round(position.z + (dz / length) * scale - 0.5),
    };
    const current = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    if (samePosition(step, current)) throw new Error("无法为蓝图目标生成分段移动点");
    const result = await moveTo(window, { ...step, dimension, distance: 2.5 }, { signal });
    if (result.ok === false) throw new Error(result.executionError || "前往蓝图施工区域失败");
  }
  throw new Error("前往蓝图施工区域超过安全步数限制");
}

async function updateTask(taskState, id, patch) {
  return taskState ? taskState.update(id, patch) : null;
}

/** Execute a Litematica plan through the existing authoritative Mod actions. */
export async function runBlueprintBuild(window, args, { taskState = null, eventQueue = null, signal, existingTask = null, activeTasks = new Map() } = {}) {
  if (!window?.id) throw new Error("未选择 Minecraft 窗口");
  const blueprint = await readLitematic(args.name, { origin: args.origin, rotation: args.rotation ?? 0, maxBlocks: args.maxBlocks ?? 32_768 });
  const dimension = String(args.dimension).trim();
  const task = existingTask || (taskState ? await taskState.create({
    kind: "blueprint_build",
    windowId: window.id,
    goal: { action: "minecraft_build_blueprint", name: blueprint.name, origin: blueprint.origin, rotation: blueprint.rotation },
    target: { blueprint: blueprint.name, blockCount: blueprint.blockCount },
    params: args,
    resumePolicy: "safe",
  }) : { id: `blueprint-${Date.now()}` });
  if (!existingTask && taskState) await taskState.markStarted(task.id);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason || "建造已取消");
  if (signal?.aborted) abortFromCaller();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const live = { taskId: task.id, controller, cancelled: false, blueprint, dimension, progress: { total: blueprint.blockCount, completed: 0, remaining: blueprint.blockCount, phase: "preflight" } };
  activeTasks.set(task.id, live);
  eventQueue?.publish?.("agent.task_started", { taskId: task.id, kind: "blueprint_build", blueprint: blueprint.name, windowId: window.id });
  try {
    const inventory = await getInventory(window);
    const missing = missingMaterials(blueprint.materials, inventory);
    if (Object.keys(missing).length && !args.allowPartial) throw new Error(`蓝图材料不足：${JSON.stringify(missing)}`);
    const targets = sortedTargets(blueprint.targets).map((target) => ({ x: target.x, y: target.y, z: target.z, blockId: target.blockId, blockState: target.blockState }));
    const total = targets.length;
    await updateTask(taskState, task.id, { progress: { total, completed: 0, remaining: total, phase: "dispatching", materials: blueprint.materials, missing } });
    const result = await startBlueprintBuild(window, { dimension, targets, allowBreaking: args.allowBreaking === true }, {
      signal: controller.signal,
      timeoutMs: Math.max(60_000, Number(args.maxMinutes || 30) * 60_000),
      onStarted: async (live) => {
        live.operationId = live.id;
        await updateTask(taskState, task.id, { progress: { total: live.total, completed: live.completed, remaining: live.remaining, phase: live.state, operationId: live.id } });
      },
      onProgress: async (live) => {
        const progress = { total: live.total, completed: live.completed, remaining: live.remaining, phase: live.state, current: live.current, blockState: live.currentBlockState };
        await updateTask(taskState, task.id, { progress });
        eventQueue?.publish?.("agent.task_progress", { taskId: task.id, kind: "blueprint_build", ...progress });
      },
    });
    if (result.ok === false) throw new Error(result.executionError || "蓝图建造失败");
    const completed = Number(result.blueprint?.completed ?? total);
    const finished = { ok: true, taskId: task.id, blueprint: blueprint.name, origin: blueprint.origin, rotation: blueprint.rotation, total, placed: completed, materials: blueprint.materials, stateVerification: "mod_block_state_readback" };
    if (taskState) await taskState.update(task.id, { status: "succeeded", finishedAt: new Date().toISOString(), progress: { total, completed, remaining: 0, phase: "completed" }, failure: null });
    eventQueue?.publish?.("agent.task_finished", { taskId: task.id, kind: "blueprint_build", status: "succeeded", placed: completed });
    return finished;
  } catch (error) {
    const cancelled = controller.signal.aborted || live.cancelled;
    if (taskState) await taskState.update(task.id, { status: cancelled ? "cancelled" : "failed", finishedAt: new Date().toISOString(), failure: { failed: !cancelled, retryable: !cancelled, score: 0, reason: error.message || String(error), category: cancelled ? "cancelled" : "blueprint_build" } });
    eventQueue?.publish?.("agent.task_finished", { taskId: task.id, kind: "blueprint_build", status: cancelled ? "cancelled" : "failed", error: error.message || String(error) });
    if (cancelled) return { ok: false, cancelled: true, taskId: task.id, executionError: "建造已取消" };
    return { ok: false, taskId: task.id, executionError: error.message || String(error) };
  } finally {
    signal?.removeEventListener("abort", abortFromCaller);
    activeTasks.delete(task.id);
  }
}

export function registerBlueprintTools(registry, { taskState = null, eventQueue = null, activeTasks = new Map() } = {}) {
  registry.register({
    name: "minecraft_blueprints",
    description: "列出后端允许目录中可用的 .litematic 文件名。开始建造前应先调用此工具，使用返回的实际文件名。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    handler: () => listLitematicNames(),
  });
  registry.register({
    name: "minecraft_build_blueprint",
    description: "读取后端受限蓝图目录中的 .litematic 文件，预检查材料，比较当前世界并按支撑顺序移动、清障和放置方块。大型建造会创建可查询、可停止、可续跑任务；必须先观察获得 dimension 和明确 origin。",
    parameters: BUILD_SCHEMA,
    timeoutMs: 15 * 60_000,
    handler: (args, context) => runBlueprintBuild(context.window, args, { taskState, eventQueue, signal: context.signal, activeTasks }),
  });
  registry.register({
    name: "minecraft_build_status",
    description: "查询蓝图建造任务的实时状态、进度、当前方块和失败原因。",
    parameters: { type: "object", properties: { taskId: { type: "string", minLength: 1, maxLength: 100 } }, required: ["taskId"], additionalProperties: false },
    readOnly: true,
    handler: (args) => taskState?.get(args.taskId) || { ok: false, executionError: "建造任务不存在" },
  });
  registry.register({
    name: "minecraft_build_stop",
    description: "停止正在执行的蓝图建造任务，并保留已完成进度以便后续续跑。",
    parameters: { type: "object", properties: { taskId: { type: "string", minLength: 1, maxLength: 100 } }, required: ["taskId"], additionalProperties: false },
    handler: async (args) => {
      const current = taskState?.get(args.taskId);
      if (current && ["succeeded", "failed", "cancelled"].includes(current.status)) return current;
      const active = activeTasks.get(args.taskId);
      if (active) { active.cancelled = true; active.controller.abort("用户停止蓝图建造"); }
      return taskState ? taskState.cancel(args.taskId, "用户停止蓝图建造") : { ok: true, taskId: args.taskId, cancelled: true };
    },
  });
  return registry;
}

export { BUILD_SCHEMA, itemId, chooseFace };
