import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventQueue } from "../event-queue.mjs";
import { MinecraftEventSource } from "../minecraft-event-source.mjs";
import { TaskStateStore } from "../task-state.mjs";

test("EventQueue coalesces realtime snapshots and preserves urgent events", () => {
  const queue = new EventQueue({ maxSize: 2, now: () => 100 });
  queue.publish("minecraft.snapshot", { state: 1 }, { coalesceKey: "snapshot:1" });
  queue.publish("minecraft.snapshot", { state: 2 }, { coalesceKey: "snapshot:1" });
  queue.publish("minecraft.task", { state: "error" }, { urgent: true });
  queue.publish("minecraft.connected", {}, { urgent: true });
  const events = queue.peek();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["minecraft.task", "minecraft.connected"]);
  assert.equal(queue.state().dropped, 1);
});

test("MinecraftEventSource emits snapshots and task transitions", async () => {
  const queue = new EventQueue();
  const observations = [
    { state: { activity: "mining" }, mining: { mining: { state: "running", active: true, broken: 0 } }, follow: null },
    { state: { activity: "idle" }, mining: { mining: { state: "completed", active: false, broken: 8, message: "done" } }, follow: null },
  ];
  let index = 0;
  const source = new MinecraftEventSource({
    queue,
    intervalMs: 10_000,
    discover: async () => [{ id: "window-1" }],
    observe: async () => observations[Math.min(index++, observations.length - 1)],
  });
  await source.start();
  await source.poll();
  await source.stop();
  const events = queue.drain();
  assert.ok(events.some((event) => event.type === "minecraft.connected"));
  const task = events.find((event) => event.type === "minecraft.task" && event.data.current.state === "completed");
  assert.equal(task.data.kind, "mining");
  assert.equal(task.data.current.state, "completed");
  assert.equal(task.urgent, true);
});

test("TaskStateStore tracks target state, evaluates failures and resumes safely", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraft-ai-task-"));
  try {
    const store = new TaskStateStore(path.join(directory, "tasks.json"));
    await store.load();
    const created = await store.create({
      kind: "mining",
      windowId: "window-1",
      goal: { quantity: 8 },
      params: { strategy: "ore", quantity: 8 },
    });
    await store.markStarted(created.id);
    let task = store.get(created.id);
    assert.equal(task.status, "running");
    await store.reconcileObservation("window-1", { mining: { mining: { state: "stuck", active: false, message: "blocked" } } }, { eventId: "event-1" });
    task = store.get(created.id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure.retryable, true);
    assert.equal(store.resumable().length, 1);
    const resumed = await store.resume(created.id, async () => ({ ok: true, started: true }));
    assert.equal(resumed.result.started, true);
    assert.equal(store.get(created.id).resumeCount, 1);
    await store.reconcileObservation("window-1", { mining: null });
    assert.equal(store.get(created.id).status, "interrupted");
    assert.equal(store.get(created.id).failure.retryable, true);
    await store.cancel(created.id);
    assert.equal(store.get(created.id).status, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
