import { getEnvironment, getInventory, scanBlocks, moveTo, breakBlock } from "./minecraft-mod-api.mjs";
import { validateSchema } from "./tool-registry.mjs";
import { EXPLORATION_SCHEMA } from "./minecraft-exploration-schema.mjs";

const DEFAULT_TARGET_BLOCKS = Object.freeze([
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
  "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
  "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore",
  "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
  "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:nether_quartz_ore", "minecraft:ancient_debris",
]);

const DROP_BY_BLOCK = Object.freeze({
  "minecraft:coal_ore": "minecraft:coal", "minecraft:deepslate_coal_ore": "minecraft:coal",
  "minecraft:iron_ore": "minecraft:raw_iron", "minecraft:deepslate_iron_ore": "minecraft:raw_iron",
  "minecraft:copper_ore": "minecraft:raw_copper", "minecraft:deepslate_copper_ore": "minecraft:raw_copper",
  "minecraft:gold_ore": "minecraft:raw_gold", "minecraft:deepslate_gold_ore": "minecraft:raw_gold",
  "minecraft:redstone_ore": "minecraft:redstone", "minecraft:deepslate_redstone_ore": "minecraft:redstone",
  "minecraft:lapis_ore": "minecraft:lapis_lazuli", "minecraft:deepslate_lapis_ore": "minecraft:lapis_lazuli",
  "minecraft:diamond_ore": "minecraft:diamond", "minecraft:deepslate_diamond_ore": "minecraft:diamond",
  "minecraft:emerald_ore": "minecraft:emerald", "minecraft:deepslate_emerald_ore": "minecraft:emerald",
  "minecraft:nether_quartz_ore": "minecraft:quartz", "minecraft:ancient_debris": "minecraft:ancient_debris",
});

const DEFAULTS = Object.freeze({
  quantity: 8,
  maxMinutes: 10,
  maxBlocks: 64,
  maxExplorationSteps: 8,
  scanRadius: 16,
  returnWhenFull: false,
});

function number(value, fallback) {
  return value === undefined ? fallback : Number(value);
}

export function validateExplorationPlan(raw = {}) {
  validateSchema(raw, EXPLORATION_SCHEMA, "工具参数");
  const targetBlocks = [...new Set((raw.targetBlocks ?? DEFAULT_TARGET_BLOCKS).map((item) => String(item).trim().toLowerCase()))];
  if (targetBlocks.some((item) => !DROP_BY_BLOCK[item])) {
    throw new Error("targetBlocks 必须是后端支持掉落核验的矿石方块");
  }
  const quantity = number(raw.quantity, DEFAULTS.quantity);
  const maxMinutes = number(raw.maxMinutes, DEFAULTS.maxMinutes);
  const maxBlocks = number(raw.maxBlocks, DEFAULTS.maxBlocks);
  const maxExplorationSteps = number(raw.maxExplorationSteps, DEFAULTS.maxExplorationSteps);
  const scanRadius = number(raw.scanRadius, DEFAULTS.scanRadius);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 256) throw new Error("quantity 必须是 1 到 256 的整数");
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 30) throw new Error("maxMinutes 必须在 0 到 30 分钟之间");
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 512) throw new Error("maxBlocks 必须是 1 到 512 的整数");
  if (!Number.isInteger(maxExplorationSteps) || maxExplorationSteps < 1 || maxExplorationSteps > 32) throw new Error("maxExplorationSteps 必须是 1 到 32 的整数");
  if (!Number.isInteger(scanRadius) || scanRadius < 4 || scanRadius > 16) throw new Error("scanRadius 必须是 4 到 16 的整数");
  return { targetBlocks, quantity, maxMinutes, maxBlocks, maxExplorationSteps, scanRadius, returnWhenFull: raw.returnWhenFull === true };
}

function positionOf(environment) {
  const position = environment?.position;
  const dimension = environment?.dimension;
  if (!position || !dimension || !["x", "y", "z"].every((key) => Number.isFinite(Number(position[key])))) {
    throw new Error("无法读取玩家位置或维度");
  }
  return { x: Math.floor(Number(position.x)), y: Math.floor(Number(position.y)), z: Math.floor(Number(position.z)), dimension: String(dimension) };
}

function countItem(inventory, itemId) {
  return (Array.isArray(inventory?.items) ? inventory.items : [])
    .filter((item) => String(item?.itemId || "").toLowerCase() === itemId)
    .reduce((sum, item) => sum + (Number.isFinite(Number(item?.count)) ? Number(item.count) : 0), 0);
}

function distance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function blockKey(block) {
  return `${block.dimension || ""}:${block.x},${block.y},${block.z}`;
}

function targetSort(a, b) {
  if (Boolean(a.visible) !== Boolean(b.visible)) return a.visible ? -1 : 1;
  if (Boolean(a.inReach) !== Boolean(b.inReach)) return a.inReach ? -1 : 1;
  return Number(a.distance ?? Infinity) - Number(b.distance ?? Infinity);
}

function scanTargets(scan, targetBlocks) {
  return (Array.isArray(scan?.blocks) ? scan.blocks : [])
    .filter((block) => targetBlocks.includes(String(block?.blockId || "").toLowerCase()))
    .map((block) => ({ ...block, blockId: String(block.blockId).toLowerCase() }))
    .sort(targetSort);
}

function approachPoints(target, origin) {
  const dx = Math.sign(Number(origin.x) - Number(target.x));
  const dz = Math.sign(Number(origin.z) - Number(target.z));
  const points = [
    { x: target.x + (dx || 1), y: target.y, z: target.z, dimension: target.dimension },
    { x: target.x, y: target.y, z: target.z + (dz || 1), dimension: target.dimension },
    { x: target.x - (dx || 1), y: target.y, z: target.z, dimension: target.dimension },
    { x: target.x, y: target.y, z: target.z - (dz || 1), dimension: target.dimension },
  ];
  return [...new Map(points.map((point) => [`${point.x},${point.y},${point.z}`, point])).values()];
}

function explorationWaypoints(origin, step) {
  const radius = 8 + (step % 3) * 8;
  const ring = [
    [radius, 0], [0, radius], [-radius, 0], [0, -radius],
    [radius, radius], [-radius, radius], [-radius, -radius], [radius, -radius],
  ];
  const [x, z] = ring[step % ring.length];
  return { x: Math.round(origin.x + x), y: Math.round(origin.y), z: Math.round(origin.z + z), dimension: origin.dimension };
}

function abortIfNeeded(signal, shouldCancel) {
  if (signal?.aborted || shouldCancel?.()) throw new Error("寻矿任务已取消");
}

function failureCategory(error) {
  const text = String(error?.message || error || "寻矿失败");
  if (/背包满/u.test(text)) return "inventory_full";
  if (/安全|岩浆|生命|饥饿|暂停|界面/u.test(text)) return "safety_stop";
  if (/超时/u.test(text)) return "timeout";
  if (/没有安全|无法安全|卡住|路线/u.test(text)) return "stuck";
  return "exploration_error";
}

function terminalFailure(message, category = "exploration_error", retryable = true, extra = {}) {
  return { ok: false, executionError: message, failure: { failed: true, retryable, score: 0, reason: message, category }, ...extra };
}

/**
 * Runs the bounded player-like exploration loop. It only reads loaded client
 * blocks and uses the normal move/break APIs; hidden blocks are never broken
 * until a later scan confirms a visible, reachable target.
 */
export async function exploreForOre(window, rawPlan, {
  signal,
  api = { getEnvironment, getInventory, scanBlocks, moveTo, breakBlock },
  taskState = null,
  existingTask = null,
  shouldCancel = null,
  onTaskCreated = null,
  onTaskFinished = null,
  onProgress = null,
} = {}) {
  const plan = validateExplorationPlan(rawPlan);
  const startedAt = Date.now();
  const deadline = startedAt + plan.maxMinutes * 60_000;
  const seenTargets = new Set();
  const visitedWaypoints = new Set();
  const minedBlocks = [];
  let explorationSteps = 0;
  let scans = 0;
  let moves = 0;
  let current = null;
  let initialInventory;
  let task = null;
  const progress = { state: "preparing", scans: 0, explorationSteps: 0, moves: 0, blocksBroken: 0, collected: 0, targetBlocks: plan.targetBlocks };

  const update = async (state, extra = {}) => {
    Object.assign(progress, { state, ...extra });
    await onProgress?.({ ...progress });
    if (taskState && task) await taskState.update(task.id, { progress: { ...progress } });
  };
  const finish = async (result, status = result.ok ? "succeeded" : result.cancelled ? "cancelled" : "failed") => {
    if (taskState && task) await taskState.update(task.id, {
      status,
      finishedAt: new Date().toISOString(),
      progress: { ...result.progress },
      failure: result.failure || null,
    });
    await onTaskFinished?.(task, result);
    return result;
  };

  if (taskState && existingTask) task = existingTask;
  if (taskState && !task) {
    task = await taskState.create({ kind: "ore_exploration", windowId: window.id, goal: { action: "minecraft_explore_for_ore", ...plan }, target: { blocks: plan.targetBlocks, quantity: plan.quantity }, params: plan, resumePolicy: "safe", maxAttempts: 3 });
    await taskState.markStarted(task.id);
  }
  await onTaskCreated?.(task);
  try {
    initialInventory = await api.getInventory(window);
    const baseline = new Map(Object.entries(DROP_BY_BLOCK).map(([, itemId]) => [itemId, countItem(initialInventory, itemId)]));
    const collected = () => [...new Set(plan.targetBlocks.map((blockId) => DROP_BY_BLOCK[blockId]))]
      .reduce((sum, itemId) => sum + Math.max(0, countItem(current?.inventory, itemId) - (baseline.get(itemId) || 0)), 0);
    const enough = () => collected() >= plan.quantity;
    const timedOut = () => Date.now() >= deadline;
    await update("observing");
    current = { environment: await api.getEnvironment(window), inventory: initialInventory };
    let noProgressCycles = 0;

    while (!enough()) {
      abortIfNeeded(signal, shouldCancel);
      if (timedOut()) return finish(terminalFailure("寻矿任务超时", "timeout", true, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      if (plan.returnWhenFull && current.inventory?.full === true) return finish(terminalFailure("背包已满", "inventory_full", false, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      await update("scanning", { collected: collected() });
      const scansForCycle = [Math.min(8, plan.scanRadius), plan.scanRadius].filter((radius, index, list) => index === 0 || radius !== list[index - 1]);
      let candidates = [];
      for (const radius of scansForCycle) {
        abortIfNeeded(signal, shouldCancel);
        const scan = await api.scanBlocks(window, { blocks: plan.targetBlocks, radius, maxResults: 64 });
        scans += 1;
        progress.scans = scans;
        const found = scanTargets(scan, plan.targetBlocks).filter((item) => !seenTargets.has(blockKey(item)));
        candidates = [...candidates, ...found];
        if (candidates.some((item) => item.visible)) break;
      }

      if (candidates.length) {
        const target = candidates[0];
        seenTargets.add(blockKey(target));
        if (!target.visible || !target.inReach) {
          await update("navigating", { target, targetVisible: Boolean(target.visible) });
          const origins = current.environment?.position ? positionOf(current.environment) : target;
          const points = target.visible ? [target] : approachPoints({ ...target, dimension: target.dimension || current.environment?.dimension }, origins);
          let approached = false;
          for (const point of points) {
            abortIfNeeded(signal, shouldCancel);
            if (distance(origins, point) > 32.5) continue;
            const moved = await api.moveTo(window, { x: point.x, y: point.y, z: point.z, dimension: target.dimension || current.environment?.dimension, distance: 1 }, { signal });
            moves += 1;
            progress.moves = moves;
            if (moved?.ok === false || moved?.move?.state !== "completed") continue;
            approached = true;
            current.environment = await api.getEnvironment(window);
            const verify = await api.scanBlocks(window, { blocks: [target.blockId], radius: 4, maxResults: 16 });
            scans += 1;
            progress.scans = scans;
            const verified = scanTargets(verify, [target.blockId]).find((item) => item.x === target.x && item.y === target.y && item.z === target.z);
            if (verified?.visible && verified.inReach) { Object.assign(target, verified); break; }
          }
          if (!approached || !target.visible || !target.inReach) {
            noProgressCycles += 1;
            continue;
          }
        }
        await update("breaking", { target });
        if (progress.blocksBroken >= plan.maxBlocks) return finish(terminalFailure("达到最大挖掘方块数", "limit_reached", false, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
        const broken = await api.breakBlock(window, { x: target.x, y: target.y, z: target.z, dimension: target.dimension || current.environment?.dimension, expectedBlockId: target.blockId }, { signal });
        if (broken?.ok === false || broken?.action?.state !== "completed" || broken.action.changed !== true) {
          noProgressCycles += 1;
          continue;
        }
        minedBlocks.push({ x: target.x, y: target.y, z: target.z, blockId: target.blockId });
        progress.blocksBroken += 1;
        await update("verifying_drop", { blocksBroken: progress.blocksBroken });
        current.inventory = await api.getInventory(window);
        progress.collected = collected();
        noProgressCycles = 0;
        continue;
      }

      if (explorationSteps >= plan.maxExplorationSteps) return finish(terminalFailure("已达到探索步数上限，当前已探索区域未发现足够矿物", "target_not_found", true, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
      const origin = positionOf(current.environment);
      const waypoint = explorationWaypoints(origin, explorationSteps);
      const waypointKey = `${waypoint.x},${waypoint.y},${waypoint.z}`;
      explorationSteps += 1;
      progress.explorationSteps = explorationSteps;
      if (visitedWaypoints.has(waypointKey)) continue;
      visitedWaypoints.add(waypointKey);
      await update("exploring", { waypoint });
      const moved = await api.moveTo(window, waypoint, { signal });
      moves += 1;
      progress.moves = moves;
      if (moved?.ok === false || moved?.move?.state !== "completed") {
        noProgressCycles += 1;
        if (noProgressCycles >= 3) return finish(terminalFailure("连续三个探索航点均无法安全到达", "stuck", true, { progress: { ...progress, collected: collected() }, taskId: task?.id }));
        continue;
      }
      current.environment = await api.getEnvironment(window);
      current.inventory = await api.getInventory(window);
      noProgressCycles = 0;
    }
    const result = { ok: true, state: "completed", collected: progress.collected, requestedQuantity: plan.quantity, blocksBroken: progress.blocksBroken, minedBlocks, progress: { ...progress, state: "completed" }, taskId: task?.id };
    return finish(result);
  } catch (error) {
    const cancelled = signal?.aborted || /已取消/u.test(String(error?.message || ""));
    const category = cancelled ? "cancelled" : failureCategory(error);
    const message = cancelled ? "寻矿任务已取消" : (error?.message || String(error));
    const result = terminalFailure(message, category, !["cancelled", "inventory_full", "safety_stop"].includes(category), { cancelled, progress: { ...progress }, taskId: task?.id });
    return finish(result, cancelled ? "cancelled" : "failed");
  }
}

export function registerExplorationTools(registry, { taskState = null, api, activeTasks = new Map() } = {}) {
  registry.register({
    name: "minecraft_explore_for_ore",
    description: "按真实玩家方式分阶段扫描已加载区域，安全导航到矿石，重新验证后挖掘，并读取背包确认掉落；找不到时会步行探索并加载新区域。不会读取未加载区块或隔墙直接挖掘。",
    parameters: EXPLORATION_SCHEMA,
    readOnly: false,
    handler: (args, context) => {
      let taskId = null;
      return exploreForOre(context.window, args, {
        signal: context.signal,
        api,
        taskState,
        shouldCancel: () => Boolean(taskId && activeTasks.get(taskId)?.cancelled),
        onTaskCreated: (task) => { if (task) { taskId = task.id; activeTasks.set(task.id, { callId: context.callId, cancelled: false }); } },
        onTaskFinished: (task) => { if (task) activeTasks.delete(task.id); },
      });
    },
  });
  return { registry, activeTasks };
}

export { DEFAULT_TARGET_BLOCKS, DROP_BY_BLOCK, DEFAULTS };
