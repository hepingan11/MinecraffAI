import { randomUUID } from "node:crypto";

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{1,80}$/u;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * A bounded, backend-owned event queue shared by chat, world observations and
 * task transitions. Coalescing is used for high-frequency snapshots so a
 * disconnected model cannot make the queue grow without bound.
 */
export class EventQueue {
  constructor({ maxSize = 512, historySize = 200, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 10_000) throw new Error("事件队列容量必须在 1 到 10000 之间");
    if (typeof now !== "function") throw new Error("事件队列时钟必须是函数");
    this.maxSize = maxSize;
    if (!Number.isInteger(historySize) || historySize < 1 || historySize > 10_000) throw new Error("事件历史容量必须在 1 到 10000 之间");
    this.historySize = historySize;
    this.now = now;
    this.entries = [];
    this.history = [];
    this.sequence = 0;
    this.dropped = 0;
    this.listeners = new Set();
    this.lastEventAt = null;
  }

  publish(type, data = {}, options = {}) {
    if (typeof type !== "string" || !EVENT_TYPE_PATTERN.test(type)) throw new Error(`事件类型无效：${type}`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("事件数据必须是对象");
    const sequence = ++this.sequence;
    const event = Object.freeze({
      id: text(options.id) || `${this.now()}-${sequence}-${randomUUID()}`,
      sequence,
      type,
      at: Number.isFinite(options.at) ? Number(options.at) : this.now(),
      source: text(options.source, "backend"),
      windowId: options.windowId === undefined || options.windowId === null ? null : text(String(options.windowId)),
      urgent: options.urgent === true,
      data: clone(data),
    });
    const coalesceKey = text(options.coalesceKey);
    if (coalesceKey) {
      const previous = this.entries.findIndex((entry) => entry.coalesceKey === coalesceKey);
      if (previous >= 0) this.entries.splice(previous, 1);
    }
    this.entries.push({ ...event, coalesceKey: coalesceKey || null });
    while (this.entries.length > this.maxSize) {
      const index = this.entries.findIndex((entry) => !entry.urgent);
      this.entries.splice(index >= 0 ? index : 0, 1);
      this.dropped += 1;
    }
    this.lastEventAt = event.at;
    this.history.push(clone(event));
    while (this.history.length > this.historySize) this.history.shift();
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* event consumers cannot break producers */ }
    }
    return clone(event);
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new Error("事件监听器必须是函数");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  peek(limit = this.maxSize) {
    const count = Math.max(1, Math.min(Number(limit) || this.maxSize, this.maxSize));
    return this.entries.slice(-count).map((entry) => clone(entry));
  }

  recent(limit = this.historySize) {
    const count = Math.max(1, Math.min(Number(limit) || this.historySize, this.history.length || 1));
    return this.history.slice(-count).map((entry) => clone(entry));
  }

  drain(limit = this.maxSize) {
    const count = Math.max(1, Math.min(Number(limit) || this.maxSize, this.entries.length || 1));
    return this.entries.splice(0, count).map((entry) => clone(entry));
  }

  clear() {
    this.entries.length = 0;
  }

  get size() {
    return this.entries.length;
  }

  state() {
    return { size: this.entries.length, maxSize: this.maxSize, historySize: this.history.length, dropped: this.dropped, lastEventAt: this.lastEventAt };
  }
}

export { EVENT_TYPE_PATTERN };
