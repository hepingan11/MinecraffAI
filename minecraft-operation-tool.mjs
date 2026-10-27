/** Registers a bounded Mod operation with durable task tracking. Physical execution
 * and cancellation stay in the Mod API wrapper; terminal actions are never replayed. */
export function registerOperationTool(registry, { name, description, parameters, run, kind, resultKey }, { taskState = null } = {}) {
  registry.register({ name, description, parameters, handler: async (args, context) => {
    let task;
    try {
      const result = await run(context.window, args, {
        signal: context.signal,
        onStarted: taskState ? async (live) => {
          task = await taskState.create({ kind, windowId: context.window.id, goal: { action: name, ...args }, params: args, resumePolicy: "never" });
          await taskState.markStarted(task.id);
          await taskState.update(task.id, { progress: { state: live.state, operationId: live.id, position: live.position } });
        } : undefined,
      });
      if (task) {
        const live = result[resultKey];
        const cancelled = live.state === "cancelled";
        await taskState.update(task.id, {
          status: cancelled ? "cancelled" : result.ok === false ? "failed" : "succeeded", finishedAt: new Date().toISOString(),
          progress: { ...taskState.get(task.id).progress, state: live.state, changed: live.changed,
            ...(live.produced === undefined ? {} : { produced: live.produced, requestedQuantity: live.requestedQuantity, recoveryRequired: live.recoveryRequired }) },
          failure: result.ok === false ? { failed: !cancelled, retryable: false, score: 0, reason: result.executionError } : null,
        });
      }
      return { ...result, ...(task ? { taskId: task.id } : {}) };
    } catch (error) {
      const live = error.operationResult;
      const status = live ? live.active ? "interrupted" : live.state === "completed" ? "succeeded" : live.state === "cancelled" ? "cancelled" : "failed"
        : context.signal?.aborted ? "cancelled" : "failed";
      if (task) await taskState.update(task.id, {
        status, finishedAt: new Date().toISOString(),
        ...(live ? { progress: { ...taskState.get(task.id).progress, ...live, operationId: live.id } } : {}),
        failure: { failed: !["succeeded", "cancelled"].includes(status), retryable: false, score: 0, reason: live?.message || error.message },
      });
      if (live) return { ok: false, executionError: error.message, [resultKey]: live, ...(task ? { taskId: task.id } : {}) };
      throw error;
    }
  } });
  return registry;
}
