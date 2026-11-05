import { setTimeout as delay } from "node:timers/promises";
import { validateSchema } from "../core/tool-registry.mjs";
import { getEnvironment, getInventory, scanBlocks, moveTo, breakBlock } from "../minecraft/minecraft-mod-api.mjs";
import { TREE_DEFAULTS, TREE_LOGS, TREE_LEAVES, TREE_DROPS, TREE_SCHEMA } from "../minecraft/minecraft-tree-schema.mjs";

const LOGS = new Set(TREE_LOGS);
const LEAVES = new Set(TREE_LEAVES);
const DROPS = new Set(TREE_DROPS);
const MAX_SCAN_RADIUS = 64;
const MAX_SCAN_VERTICAL_RADIUS = 32;

function number(value, fallback) { return value === undefined ? fallback : Number(value); }

export function validateTreePlan(raw = {}) {
  validateSchema(raw, TREE_SCHEMA, "砍树参数");
  const quantity = number(raw.quantity, TREE_DEFAULTS.quantity);
  const maxMinutes = number(raw.maxMinutes, TREE_DEFAULTS.maxMinutes);
  const maxBlocks = number(raw.maxBlocks, TREE_DEFAULTS.maxBlocks);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 256) throw new Error("quantity 必须是 1 到 256 的整数");
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 15) throw new Error("maxMinutes 必须在 0 到 15 分钟之间");
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 512) throw new Error("maxBlocks 必须是 1 到 512 的整数");
  return { quantity, maxMinutes, maxBlocks, returnWhenFull: raw.returnWhenFull === true };
}

function positionOf(environment) {
  const position = environment?.position;
  const dimension = environment?.dimension;
  if (!position || !dimension || !["x", "y", "z"].every((key) => Number.isFinite(Number(position[key])))) {
    throw new Error("无法读取玩家位置或维度");
  }
  return { x: Math.floor(Number(position.x)), y: Math.floor(Number(position.y)), z: Math.floor(Number(position.z)), dimension: String(dimension) };
}

function distance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function key(block) { return `${block.dimension || ""}:${block.x},${block.y},${block.z}`; }

function countItem(inventory, itemIds) {
  const wanted = new Set(itemIds);
  return (Array.isArray(inventory?.items) ? inventory.items : [])
    .filter((item) => wanted.has(String(item?.itemId || "").toLowerCase()))
    .reduce((sum, item) => sum + Math.max(0, Number(item?.count) || 0), 0);
}

function completedMove(result) { return result?.ok !== false && result?.move?.state === "completed"; }
function completedBreak(result) { return result?.ok !== false && result?.action?.state === "completed" && result.action.changed === true; }

function failure(message, category = "tree_chopping", retryable = true, extra = {}) {
  return { ok: false, executionError: message, failure: { failed: true, retryable, score: 0, reason: message, category }, ...extra };
}

function failureCategory(error) {
  const text = String(error?.message || error || "砍树失败");
  if (/背包满/u.test(text)) return "inventory_full";
  if (/安全|岩浆|生命|饥饿|暂停|界面/u.test(text)) return "safety_stop";
  if (/超时/u.test(text)) return "timeout";
  if (/卡住|路线/u.test(text)) return "stuck";
  return "tree_chopping";
}

function adjacent(a, b) {
  return Math.abs(Number(a.x) - Number(b.x)) + Math.abs(Number(a.y) - Number(b.y)) + Math.abs(Number(a.z) - Number(b.z)) === 1;
}

function clusters(logs) {
  const remaining = new Map(logs.map((block) => [key(block), block]));
  const result = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    const queue = [first];
    remaining.delete(key(first));
    const cluster = [];
    while (queue.length) {
      const current = queue.shift();
      cluster.push(current);
      for (const candidate of [...remaining.values()]) {
        if (String(candidate.blockId).toLowerCase() !== String(current.blockId).toLowerCase()) continue;
        if (!adjacent(current, candidate)) continue;
        remaining.delete(key(candidate));
        queue.push(candidate);
      }
    }
    result.push(cluster);
  }
  return result;
}

function nearestCluster(logClusters, origin, consumed) {
  return logClusters
    .map((blocks) => blocks.filter((block) => !consumed.has(key(block))))
    .filter((blocks) => blocks.length)
    .map((blocks) => ({ blocks, distance: Math.min(...blocks.map((block) => distance(origin, block))) }))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function sortedTargets(blocks, origin) {
  return [...blocks].sort((a, b) => Number(a.y) - Number(b.y) || distance(origin, a) - distance(origin, b));
}

function abortIfNeeded(signal, shouldCancel) {
  if (signal?.aborted || shouldCancel?.()) throw new Error("砍树任务已取消");
}

function approachPoint(origin, target, maxDistance = 24) {
  const dx = Number(target.x) - Number(origin.x);
  const dz = Number(target.z) - Number(origin.z);
  const horizontal = Math.hypot(dx, dz);
  if (horizontal <= maxDistance) return { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), dimension: target.dimension || origin.dimension };
  const scale = maxDistance / horizontal;
  return {
    x: Math.floor(Number(origin.x) + dx * scale), y: Math.floor(Number(origin.y)),
    z: Math.floor(Number(origin.z) + dz * scale), dimension: target.dimension || origin.dimension,
  };
}

export async function chopTrees(window, rawPlan, {
  signal,
  api = { getEnvironment, getInventory, scanBlocks, moveTo, breakBlock },
  taskState = null,
  existingTask = null,
  shouldCancel = null,
  onTaskCreated = null,
  onTaskFinished = null,
  onProgress = null,
} = {}) {
  const plan = validateTreePlan(rawPlan);
  const deadline = Date.now() + plan.maxMinutes * 60_000;
  const progress = { state: "preparing", scans: 0, moves: 0, blocksBroken: 0, treesFound: 0, treesChopped: 0, collected: 0, scanRadius: MAX_SCAN_RADIUS };
  const chopped = [];
  const consumed = new Set();
  let current = null;
  let initialInventory = null;
  let task = existingTask;
  let scan = null;

  const update = async (state, extra = {}) => {
    Object.assign(progress, { state, ...extra });
    await onProgress?.({ ...progress });
    if (taskState && task) await taskState.update(task.id, { progress: { ...progress } });
  };
  const finish = async (result, status = result.ok ? "succeeded" : result.cancelled ? "cancelled" : "failed") => {
    if (taskState && task) await taskState.update(task.id, { status, finishedAt: new Date().toISOString(), progress: { ...result.progress }, failure: result.failure || null });
    await onTaskFinished?.(task, result);
    return result;
  };
  if (taskState && !task) {
    task = await taskState.create({ kind: "tree_chopping", windowId: window.id, goal: { action: "minecraft_chop_tree", ...plan }, target: { quantity: plan.quantity }, params: plan, resumePolicy: "safe", maxAttempts: 3 });
    await taskState.markStarted(task.id);
  }
  await onTaskCreated?.(task);

  try {
    initialInventory = await api.getInventory(window);
    const logItems = TREE_LOGS;
    const baseline = countItem(initialInventory, logItems);
    const collected = () => Math.max(0, countItem(current?.inventory, logItems) - baseline);
    const enough = () => collected() >= plan.quantity;
    const timedOut = () => Date.now() >= deadline;
    current = { environment: await api.getEnvironment(window), inventory: initialInventory };

    const collectDrops = async () => {
      current.environment = await api.getEnvironment(window);
      const drops = (Array.isArray(current.environment?.nearbyEntities) ? current.environment.nearbyEntities : [])
        .filter((entity) => String(entity?.type || "").toLowerCase() === "minecraft:item")
        .filter((entity) => DROPS.has(String(entity?.itemId || "").toLowerCase()))
        .filter((entity) => ["x", "y", "z"].every((field) => Number.isFinite(Number(entity[field]))))
        .sort((a, b) => Number(a.distance ?? Infinity) - Number(b.distance ?? Infinity));
      for (const drop of drops) {
        abortIfNeeded(signal, shouldCancel);
        const moved = await api.moveTo(window, { x: Math.floor(Number(drop.x)), y: Math.floor(Number(drop.y)), z: Math.floor(Number(drop.z)), dimension: current.environment.dimension, distance: 1 }, { signal });
        progress.moves += 1;
        if (completedMove(moved)) {
          await delay(300, undefined, { signal });
          current.environment = await api.getEnvironment(window);
        }
      }
      current.inventory = await api.getInventory(window);
      progress.collected = collected();
    };

    const moveNear = async (target) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        abortIfNeeded(signal, shouldCancel);
        const origin = positionOf(current.environment);
        const point = approachPoint(origin, target);
        const moved = await api.moveTo(window, point, { signal });
        progress.moves += 1;
        if (!completedMove(moved)) return false;
        current.environment = await api.getEnvironment(window);
        if (distance(positionOf(current.environment), target) <= 4.6) return true;
      }
      return false;
    };

    while (!enough()) {
      abortIfNeeded(signal, shouldCancel);
      if (timedOut()) return finish(failure("砍树任务超时", "timeout", true, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      if (plan.returnWhenFull && current.inventory?.full === true) return finish(failure("背包已满", "inventory_full", false, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      await update("scanning", { collected: collected() });
      scan = await api.scanBlocks(window, { blocks: TREE_LOGS, radius: MAX_SCAN_RADIUS, verticalRadius: MAX_SCAN_VERTICAL_RADIUS, maxResults: 256 }, { timeoutMs: 20_000 });
      progress.scans += 1;
      const logs = (Array.isArray(scan?.blocks) ? scan.blocks : [])
        .filter((block) => LOGS.has(String(block?.blockId || "").toLowerCase()))
        .filter((block) => !consumed.has(key(block)));
      if (!logs.length) return finish(failure("64 格范围内没有发现已加载的树干", "target_not_found", true, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      const origin = positionOf(current.environment);
      const treeClusters = clusters(logs);
      progress.treesFound = Math.max(progress.treesFound, treeClusters.length);
      const selected = nearestCluster(treeClusters, origin, consumed);
      if (!selected) return finish(failure("没有可继续砍伐的树干", "target_not_found", true, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      progress.treesChopped += 1;
      const targets = sortedTargets(selected.blocks, origin);
      let treeBroken = 0;
      for (const target of targets) {
        if (enough() || progress.blocksBroken >= plan.maxBlocks) break;
        abortIfNeeded(signal, shouldCancel);
        consumed.add(key(target));
        if (!(target.visible && target.inReach)) {
          await update("navigating", { target });
          if (!(await moveNear(target))) continue;
          const verify = await api.scanBlocks(window, { blocks: [target.blockId], radius: 4, verticalRadius: 4, maxResults: 16 });
          progress.scans += 1;
          const exact = (verify.blocks || []).find((block) => block.x === target.x && block.y === target.y && block.z === target.z && block.visible && block.inReach);
          if (!exact) continue;
        }
        if (progress.blocksBroken >= plan.maxBlocks) break;
        await update("breaking", { target });
        const broken = await api.breakBlock(window, { x: target.x, y: target.y, z: target.z, dimension: target.dimension || current.environment.dimension, expectedBlockId: target.blockId }, { signal });
        if (!completedBreak(broken)) {
          if (broken?.executionError && !/方块已变化|目标已不存在|目标位置已变化|目标区块尚未加载/u.test(String(broken.executionError))) {
            const category = failureCategory(broken.executionError);
            return finish(failure(broken.executionError, category, !["inventory_full", "safety_stop"].includes(category), { progress: { ...progress, collected: collected() }, taskId: task?.id }));
          }
          continue;
        }
        treeBroken += 1;
        progress.blocksBroken += 1;
        chopped.push({ x: target.x, y: target.y, z: target.z, blockId: target.blockId });
        await update("collecting", { blocksBroken: progress.blocksBroken });
        await collectDrops();
      }
      if (treeBroken > 0) await collectDrops();
      if (treeBroken === 0) {
        // Do not loop forever on an unreachable tree cluster; a fresh scan can
        // choose another tree that is actually exposed and navigable.
        for (const block of selected.blocks) consumed.add(key(block));
      }
    }
    return finish({ ok: true, state: "completed", collected: progress.collected, requestedQuantity: plan.quantity, blocksBroken: progress.blocksBroken, treesFound: progress.treesFound, treesChopped: progress.treesChopped, chopped, progress: { ...progress, state: "completed" }, taskId: task?.id });
  } catch (error) {
    const cancelled = signal?.aborted || /已取消/u.test(String(error?.message || ""));
    const category = cancelled ? "cancelled" : failureCategory(error);
    const result = failure(cancelled ? "砍树任务已取消" : error?.message || String(error), category, !["cancelled", "inventory_full", "safety_stop"].includes(category), { cancelled, progress: { ...progress }, taskId: task?.id });
    return finish(result, cancelled ? "cancelled" : "failed");
  }
}

export function registerTreeTools(registry, { taskState = null, api, activeTasks = new Map(), eventQueue = null } = {}) {
  registry.register({
    name: "minecraft_chop_tree",
    description: "扫描玩家附近 64 格内已加载的树干，安全移动并用兼容斧头砍伐，自动走到木材掉落物处拾取并读取背包确认。不会读取未加载区块或隔墙直接破坏。",
    parameters: TREE_SCHEMA,
    readOnly: false,
    timeoutMs: 15 * 60_000,
    handler: (args, context) => {
      let taskId = null;
      return chopTrees(context.window, args, {
        signal: context.signal,
        api,
        taskState,
        shouldCancel: () => Boolean(taskId && activeTasks.get(taskId)?.cancelled),
        onTaskCreated: (task) => { if (task) { taskId = task.id; activeTasks.set(task.id, { callId: context.callId, cancelled: false }); } },
        onTaskFinished: (task) => { if (task) activeTasks.delete(task.id); },
        onProgress: (progress) => eventQueue?.publish?.("agent.task_progress", { taskId, kind: "tree_chopping", progress }, { source: "tree-chopping", windowId: context.window?.id }),
      });
    },
  });
  return { registry, activeTasks };
}

export { TREE_LOGS, TREE_LEAVES, TREE_DROPS, TREE_DEFAULTS, LOGS, LEAVES, DROPS };

