import { discoverWindows, getObservation } from "./minecraft-mod-api.mjs";

const DEFAULT_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set([
  "completed", "limit_reached", "stopped", "timeout", "safety_stop", "inventory_full", "stuck", "target_lost", "error",
]);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  try { return JSON.stringify(value); } catch { return ""; }
}

function taskFromObservation(observation, kind) {
  const source = kind === "mining" ? observation?.mining?.mining : kind === "follow" ? observation?.follow?.follow
    : kind === "move" ? observation?.state?.move : kind === "craft" ? observation?.state?.craft : observation?.state?.action;
  if (!source || typeof source !== "object") return null;
  return clone(source);
}

function isUrgentTransition(previous, current) {
  return Boolean(current && TERMINAL_STATES.has(String(current.state || "")) && current.state !== previous?.state);
}

/** Polls live Mod state and turns changes into queue events. Chat is only one
 * input; task transitions and connection changes use the same queue. */
export class MinecraftEventSource {
  constructor({ queue, discover = discoverWindows, observe = getObservation, intervalMs = DEFAULT_INTERVAL_MS, now = () => Date.now() } = {}) {
    if (!queue || typeof queue.publish !== "function") throw new Error("MinecraftEventSource 需要事件队列");
    this.queue = queue;
    this.discover = discover;
    this.observe = observe;
    this.intervalMs = Number.isInteger(intervalMs) && intervalMs >= 250 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.polling = false;
    this.snapshots = new Map();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.poll();
    this.timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      const windows = await this.discover();
      const seen = new Set();
      for (const window of windows) {
        const windowId = String(window.id);
        seen.add(windowId);
        try {
          const observation = await this.observe(window);
          this.publishObservation(window, observation);
        } catch (error) {
          this.queue.publish("minecraft.error", { error: error.message || String(error) }, {
            source: "minecraft-event-source", windowId, urgent: true, coalesceKey: `error:${windowId}`,
          });
        }
      }
      for (const [windowId, previous] of this.snapshots) {
        if (!seen.has(windowId)) {
          this.queue.publish("minecraft.disconnected", { previous }, { source: "minecraft-event-source", windowId, urgent: true });
          this.snapshots.delete(windowId);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  publishObservation(window, observation) {
    const windowId = String(window.id);
    const previous = this.snapshots.get(windowId);
    const current = clone(observation);
    this.queue.publish("minecraft.snapshot", { observation: current }, {
      source: "minecraft-event-source", windowId, coalesceKey: `snapshot:${windowId}`,
    });
    if (!previous) {
      this.queue.publish("minecraft.connected", { observation: current }, { source: "minecraft-event-source", windowId, urgent: true });
    }
    for (const kind of ["mining", "follow", "move", "block_action", "craft"]) {
      const before = taskFromObservation(previous, kind);
      const after = taskFromObservation(current, kind);
      if (stable(before) === stable(after)) continue;
      this.queue.publish("minecraft.task", {
        kind,
        previous: before,
        current: after,
        changedAt: this.now(),
      }, {
        // Successful completion of an awaited atomic call must not cancel that same call.
        source: "minecraft-event-source", windowId, urgent: isUrgentTransition(before, after)
          && (!["move", "block_action", "craft"].includes(kind) || !["completed", "cancelled"].includes(after?.state)),
      });
    }
    this.snapshots.set(windowId, current);
  }
}

export { TERMINAL_STATES, taskFromObservation };
