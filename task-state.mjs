import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = process.env.MC_AI_TASKS_PATH?.trim() || path.join(ROOT, "data", "tasks.json");
const MAX_TASKS = 200;
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/u;
const ACTIVE_STATES = new Set(["running", "equipping", "moving", "breaking", "waiting_target", "following", "holding", "pathfinding"]);
const SUCCESS_STATES = new Set(["completed", "limit_reached"]);
const PAUSED_STATES = new Set(["paused", "waiting_target"]);
const FAILURE_STATES = new Set(["stopped", "timeout", "safety_stop", "inventory_full", "stuck", "target_lost", "error", "interrupted"]);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function safeText(value, max = 500) {
  const result = String(value ?? "").trim();
  if (result.length > max) throw new Error(`任务文本不能超过 ${max} 个字符`);
  return result;
}

function assessmentForState(state, message = "") {
  const normalized = String(state || "").toLowerCase();
  if (SUCCESS_STATES.has(normalized)) return { failed: false, retryable: false, score: 1, reason: message || normalized };
  if (PAUSED_STATES.has(normalized)) return { failed: false, retryable: true, score: 0.5, reason: message || normalized };
  if (FAILURE_STATES.has(normalized)) {
    const retryable = !["safety_stop", "inventory_full", "target_lost"].includes(normalized);
    return { failed: true, retryable, score: 0, reason: message || normalized, category: normalized };
  }
  return { failed: false, retryable: true, score: null, reason: message || normalized || "unknown" };
}

function normalizeTask(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("任务状态格式无效");
  const id = String(raw.id || randomUUID());
  if (!TASK_ID_PATTERN.test(id)) throw new Error("任务 ID 无效");
  const kind = safeText(raw.kind, 80);
  if (!/^[a-z][a-z0-9_.-]{1,79}$/u.test(kind)) throw new Error("任务类型无效");
  const status = safeText(raw.status || "pending", 30).toLowerCase();
  const allowed = new Set(["pending", "running", "paused", "succeeded", "failed", "cancelled", "interrupted"]);
  if (!allowed.has(status)) throw new Error("任务状态无效");
  const now = new Date().toISOString();
  return {
    id,
    kind,
    windowId: raw.windowId === undefined || raw.windowId === null ? null : safeText(raw.windowId, 200),
    goal: clone(raw.goal && typeof raw.goal === "object" ? raw.goal : { description: safeText(raw.goal, 500) }),
    target: clone(raw.target && typeof raw.target === "object" ? raw.target : {}),
    targetState: clone(raw.targetState && typeof raw.targetState === "object" ? raw.targetState : { status: "unknown", lastSeenAt: null }),
    params: clone(raw.params && typeof raw.params === "object" ? raw.params : {}),
    status,
    progress: clone(raw.progress && typeof raw.progress === "object" ? raw.progress : {}),
    failure: clone(raw.failure || null),
    resumePolicy: ["never", "safe", "always"].includes(raw.resumePolicy) ? raw.resumePolicy : "safe",
    maxAttempts: Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 1 && raw.maxAttempts <= 10 ? raw.maxAttempts : 3,
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    resumeCount: Number.isInteger(raw.resumeCount) && raw.resumeCount >= 0 ? raw.resumeCount : 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    lastEventId: raw.lastEventId || null,
  };
}

function publicTask(task) {
  return clone(task);
}

/** Durable generic task/goal state. Mod-specific code only supplies an
 * observation; failure policy and resumability stay in this backend layer. */
export class TaskStateStore {
  constructor(filePath = DEFAULT_PATH, { now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.tasks = new Map();
    this.loaded = false;
    this.persistChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(raw)) throw new Error("任务文件必须是数组");
      this.tasks = new Map(raw.slice(-MAX_TASKS).map((item) => {
        const task = normalizeTask(item);
        return [task.id, task];
      }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`读取任务状态失败：${error.message}`);
      this.tasks = new Map();
    }
    this.loaded = true;
    return this.list();
  }

  async persist() {
    const contents = `${JSON.stringify([...this.tasks.values()].slice(-MAX_TASKS), null, 2)}\n`;
    const write = this.persistChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, contents, "utf8");
      await rename(temporary, this.filePath);
    });
    this.persistChain = write;
    await write;
  }

  async create({ id, kind, windowId = null, goal = {}, target = {}, params = {}, resumePolicy = "safe", maxAttempts = 3 } = {}) {
    const task = normalizeTask({ id, kind, windowId, goal, target, params, resumePolicy, maxAttempts, status: "pending" });
    if (this.tasks.has(task.id)) throw new Error(`任务已存在：${task.id}`);
    if (this.tasks.size >= MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value);
    this.tasks.set(task.id, task);
    await this.persist();
    return publicTask(task);
  }

  get(id) {
    return this.tasks.has(String(id || "")) ? publicTask(this.tasks.get(String(id))) : null;
  }

  list({ windowId, status, kind } = {}) {
    return [...this.tasks.values()]
      .filter((task) => windowId === undefined || task.windowId === String(windowId))
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => kind === undefined || task.kind === kind)
      .map(publicTask);
  }

  async update(id, patch = {}) {
    const task = this.tasks.get(String(id || ""));
    if (!task) throw new Error("任务不存在");
    const next = normalizeTask({ ...task, ...clone(patch), id: task.id, updatedAt: this.now() });
    this.tasks.set(task.id, next);
    await this.persist();
    return publicTask(next);
  }

  async markStarted(id) {
    const task = this.tasks.get(String(id || ""));
    if (!task) throw new Error("任务不存在");
    task.status = "running";
    task.attempts += 1;
    task.startedAt ||= this.now();
    task.updatedAt = this.now();
    task.failure = null;
    await this.persist();
    return publicTask(task);
  }

  async reconcileObservation(windowId, observation, { eventId = null } = {}) {
    const results = [];
    for (const task of this.tasks.values()) {
      if (task.windowId !== String(windowId)) continue;
      if (["move", "block_action", "craft"].includes(task.kind)) {
        const live = observation?.state?.[task.kind === "move" ? "move" : task.kind === "craft" ? "craft" : "action"];
        // Terminal history cannot be revived by a stale snapshot or another operation.
        if (!["running", "pending"].includes(task.status) || !live || live.id !== task.progress.operationId) continue;
        const assessment = assessmentForState(live.state, live.message);
        task.progress = { ...task.progress, state: live.state, position: live.position, changed: live.changed };
        if (task.kind === "craft") task.progress = { ...task.progress, produced: live.produced, requestedQuantity: live.requestedQuantity, recoveryRequired: live.recoveryRequired };
        task.updatedAt = this.now(); task.lastEventId = eventId || task.lastEventId;
        if (!live.active) {
          task.status = live.state === "completed" ? "succeeded" : live.state === "cancelled" ? "cancelled" : "failed";
          task.failure = assessment.failed ? assessment : null;
          task.finishedAt = this.now();
        }
        results.push(publicTask(task));
        continue;
      }
      const componentKey = task.kind === "mining" ? "mining" : task.kind === "follow" ? "follow" : null;
      if (!componentKey || !observation || !Object.prototype.hasOwnProperty.call(observation, componentKey)) continue;
      const component = observation[componentKey];
      const live = component?.[componentKey];
      if (!live || typeof live !== "object") {
        if (["pending", "running", "paused"].includes(task.status)) {
          task.status = "interrupted";
          task.failure = { failed: true, retryable: true, score: 0, reason: "实时状态显示任务已不存在", category: "interrupted" };
          task.updatedAt = this.now();
          results.push(publicTask(task));
        }
        continue;
      }
      const state = String(live.state || (live.active ? "running" : "unknown")).toLowerCase();
      const assessment = assessmentForState(state, live.message);
      const status = live.active === true || ACTIVE_STATES.has(state)
        ? (state === "paused" ? "paused" : "running")
        : assessment.failed ? "failed" : assessment.score === 1 ? "succeeded" : "interrupted";
      const targetName = live.targetName || live.targetUuid || live.currentTarget?.id || null;
      task.status = status;
      task.progress = { ...task.progress, state, ...(live.broken === undefined ? {} : { broken: live.broken }), ...(live.distance === undefined ? {} : { distance: live.distance }) };
      task.targetState = {
        ...task.targetState,
        status: state === "target_lost" ? "lost" : targetName ? "visible" : state === "completed" ? "reached" : task.targetState.status,
        id: live.targetUuid || live.currentTarget?.id || task.targetState.id || null,
        name: targetName || task.targetState.name || null,
        lastSeenAt: targetName ? this.now() : task.targetState.lastSeenAt,
      };
      task.failure = assessment.failed ? assessment : null;
      task.lastEventId = eventId || task.lastEventId;
      task.updatedAt = this.now();
      if (["succeeded", "failed", "interrupted"].includes(status)) task.finishedAt ||= this.now();
      results.push(publicTask(task));
    }
    if (results.length) await this.persist();
    return results;
  }

  async markInterrupted(windowId, reason = "实时状态暂时不可用") {
    const results = [];
    for (const task of this.tasks.values()) {
      if (task.windowId !== String(windowId) || !["pending", "running", "paused"].includes(task.status)) continue;
      task.status = "interrupted";
      task.failure = { failed: true, retryable: true, score: 0, reason, category: "interrupted" };
      task.updatedAt = this.now();
      results.push(publicTask(task));
    }
    if (results.length) await this.persist();
    return results;
  }

  resumable({ windowId } = {}) {
    return this.list({ windowId }).filter((task) => ["paused", "failed", "interrupted"].includes(task.status)
      && task.resumePolicy !== "never" && task.attempts < task.maxAttempts && task.failure?.retryable === true);
  }

  async resume(id, runner) {
    const task = this.tasks.get(String(id || ""));
    if (!task) throw new Error("任务不存在");
    if (!this.resumable({ windowId: task.windowId }).some((item) => item.id === task.id)) throw new Error("任务当前不可续跑");
    if (typeof runner !== "function") throw new Error("任务续跑器必须是函数");
    task.status = "running";
    task.attempts += 1;
    task.resumeCount += 1;
    task.failure = null;
    task.updatedAt = this.now();
    await this.persist();
    try {
      const result = await runner(publicTask(task));
      if (result?.executionError) {
        task.status = "failed";
        task.failure = { failed: true, retryable: task.attempts < task.maxAttempts, score: 0, reason: String(result.executionError), category: "resume_result" };
        task.updatedAt = this.now();
        await this.persist();
      }
      return { task: publicTask(task), result };
    } catch (error) {
      task.status = "failed";
      task.failure = { failed: true, retryable: task.attempts < task.maxAttempts, score: 0, reason: error.message || String(error), category: "resume_error" };
      task.updatedAt = this.now();
      await this.persist();
      return { task: publicTask(task), executionError: task.failure.reason };
    }
  }

  async cancel(id, reason = "用户取消") {
    return this.update(id, { status: "cancelled", failure: { failed: false, retryable: false, score: 0, reason, category: "cancelled" }, finishedAt: this.now() });
  }

  async cancelActive({ windowId, kind, reason = "用户停止任务" } = {}) {
    const results = [];
    for (const task of this.tasks.values()) {
      if (windowId !== undefined && task.windowId !== String(windowId)) continue;
      if (kind !== undefined && task.kind !== kind) continue;
      if (!["pending", "running", "paused", "interrupted"].includes(task.status)) continue;
      task.status = "cancelled";
      task.failure = { failed: false, retryable: false, score: 0, reason, category: "cancelled" };
      task.finishedAt = this.now();
      task.updatedAt = this.now();
      results.push(publicTask(task));
    }
    if (results.length) await this.persist();
    return results;
  }

  state() {
    const tasks = this.list();
    return {
      total: tasks.length,
      active: tasks.filter((task) => ["pending", "running", "paused"].includes(task.status)).length,
      resumable: this.resumable().length,
      failed: tasks.filter((task) => task.status === "failed").length,
      tasks,
    };
  }
}

export { DEFAULT_PATH, ACTIVE_STATES, SUCCESS_STATES, FAILURE_STATES, assessmentForState, normalizeTask };
