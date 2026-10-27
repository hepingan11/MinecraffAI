import test from "node:test";
import assert from "node:assert/strict";
import { validateTeleportPlan, teleportCommandFromChat, teleportReplyFromResult } from "../teleport-skill.mjs";

test("传送只接受明确的到我这里请求，并从聊天前缀解析玩家 ID", () => {
  assert.deepEqual(teleportCommandFromChat("<Alex> @MinecraftAI 传送到我这里来"), { action: "request", targetName: "Alex" });
  assert.deepEqual(teleportCommandFromChat("[[Alex head]Alex -> me] @MinecraftAI tp 到我这里"), { action: "request", targetName: "Alex" });
  assert.equal(teleportCommandFromChat("<Alex> @MinecraftAI 怎么传送到我这里"), null);
  assert.equal(teleportCommandFromChat("<Alex> @MinecraftAI 传送到 Steve"), null);
  assert.deepEqual(teleportCommandFromChat("@MinecraftAI 传送到我这里"), { action: "request", unresolvedSender: true });
});

test("传送目标 ID 后端校验并生成固定结果文本", () => {
  assert.deepEqual(validateTeleportPlan({ targetName: "Alex_1" }), { targetName: "Alex_1" });
  assert.throws(() => validateTeleportPlan({ targetName: "Alex;op" }), /玩家 ID 无效/u);
  assert.throws(() => validateTeleportPlan({ targetName: "" }), /玩家 ID 无效/u);
  assert.match(teleportReplyFromResult({ ok: true, targetName: "Alex" }), /Alex/u);
  assert.match(teleportReplyFromResult({ ok: false, executionError: "窗口离线" }), /窗口离线/u);
});
