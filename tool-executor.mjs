import { normalizeArguments } from "./tool-registry.mjs";

function callName(call) {
  return typeof call?.name === "string" ? call.name : call?.function?.name;
}

function callArguments(call) {
  if (call && Object.prototype.hasOwnProperty.call(call, "arguments")) return call.arguments;
  return call?.function?.arguments;
}

function normalizeCall(call, index) {
  const name = callName(call);
  return Object.freeze({
    id: typeof call?.id === "string" && call.id.trim() ? call.id : `tool_call_${index + 1}`,
    name: typeof name === "string" ? name : "",
    arguments: callArguments(call),
    raw: call,
  });
}

function failure(message, extra = {}) {
  return { ok: false, executionError: String(message), ...extra };
}

/**
 * Backend executor modelled after Numen's SerialCalls/ToolPort boundary.
 * Tools are dispatched one at a time, every result is structured, and an
 * urgent event can interrupt the active call and settle the remaining queue.
 */
export class ToolExecutor {
  constructor({ registry, maxCalls = 32, callTimeoutMs = 120_000, now = () => Date.now() } = {}) {
    if (!registry || typeof registry.invoke !== "function") throw new Error("ToolExecutor 需要 ToolRegistry");
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 256) throw new Error("工具批次上限必须在 1 到 256 之间");
    if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 100 || callTimeoutMs > 15 * 60_000) throw new Error("工具超时必须在 100 毫秒到 15 分钟之间");
    this.registry = registry;
    this.maxCalls = maxCalls;
    this.callTimeoutMs = callTimeoutMs;
    this.now = now;
    this.runState = null;
  }

  get busy() {
    return Boolean(this.runState);
  }

  current() {
    return this.runState?.current || null;
  }

  outstanding() {
    if (!this.runState) return [];
    return this.runState.calls.slice(this.runState.index).map((call) => call.id);
  }

  holds(callId) {
    return this.outstanding().includes(callId);
  }

  /** Interrupt a running batch. The active handler receives an aborted signal. */
  cancel(reason = "工具执行已取消") {
    const state = this.runState;
    if (!state) return [];
    state.cancelled = true;
    state.reason = String(reason || "工具执行已取消");
    state.controller.abort(state.reason);
    return this.outstanding();
  }

  /** Numen-style urgent input hook. Quiet snapshots do not interrupt work. */
  arrived(event, urgent = false) {
    if (!urgent || !this.runState || !this.runState.current) return false;
    if (event?.windowId && this.runState.windowId && String(event.windowId) !== this.runState.windowId) return false;
    const type = String(event?.type || "");
    if (["agent.tool_call", "agent.tool_started", "agent.tool_result"].includes(type)) return false;
    this.cancel(`收到紧急事件 ${type || "unknown"}，已中断工具执行`);
    return true;
  }

  async run(calls, context = {}, hooks = {}) {
    if (this.runState) throw new Error("已有工具批次正在执行");
    if (!Array.isArray(calls)) throw new Error("工具调用批次必须是数组");
    if (calls.length > this.maxCalls) throw new Error(`工具调用数量不能超过 ${this.maxCalls}`);
    const normalized = calls.map(normalizeCall);
    const state = {
      calls: normalized,
      index: 0,
      current: null,
      results: [],
      cancelled: false,
      reason: "工具执行已取消",
      controller: new AbortController(),
      startedAt: this.now(),
      windowId: context.window?.id === undefined ? null : String(context.window.id),
    };
    this.runState = state;
    const safeHook = async (name, payload) => {
      if (typeof hooks[name] !== "function") return;
      try { await hooks[name](payload); } catch { /* hooks are observers, never execution gates */ }
    };
    try {
      for (let index = 0; index < normalized.length; index += 1) {
        const call = normalized[index];
        state.index = index;
        state.current = call;
        if (state.cancelled) {
          const result = failure(state.reason, { cancelled: true });
          state.results.push({ call, result, startedAt: null, finishedAt: this.now() });
          await safeHook("finished", { call, result, cancelled: true });
          continue;
        }
        const startedAt = this.now();
        await safeHook("started", { call, startedAt });
        const result = await this.executeOne(call, context, state);
        const finishedAt = this.now();
        state.results.push({ call, result, startedAt, finishedAt });
        await safeHook("finished", { call, result, startedAt, finishedAt, cancelled: Boolean(result?.cancelled) });
      }
      return state.results;
    } finally {
      const result = state.results.slice();
      const cancelled = state.cancelled;
      this.runState = null;
      await safeHook("settled", { results: result, cancelled, startedAt: state.startedAt, finishedAt: this.now() });
    }
  }

  async executeOne(call, context, state) {
    if (!call.name) return failure("模型返回了没有工具名的调用");
    let args;
    try { args = normalizeArguments(call.arguments); } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    const operation = Promise.resolve()
      .then(() => this.registry.invoke(call.name, args, { ...context, signal: state.controller.signal, callId: call.id }))
      .catch((error) => failure(error instanceof Error ? error.message : String(error)));
    const abort = new Promise((resolve) => {
      if (state.controller.signal.aborted) {
        resolve(failure(state.reason, { cancelled: true }));
        return;
      }
      state.controller.signal.addEventListener("abort", () => resolve(failure(state.reason, { cancelled: true })), { once: true });
    });
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(failure(`工具执行超过 ${this.callTimeoutMs} 毫秒`, { timedOut: true })), this.callTimeoutMs);
    });
    const result = await Promise.race([operation, abort, timeout]);
    clearTimeout(timeoutHandle);
    if (result?.cancelled) state.cancelled = true;
    if (result?.timedOut) {
      state.cancelled = true;
      state.reason = result.executionError;
      state.controller.abort(state.reason);
    }
    return result;
  }
}

export { normalizeCall };
