import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExperienceStore, parseExperienceFeedback } from "../experience-store.mjs";

async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "minecraft-ai-experience-"));
  return new ExperienceStore(path.join(dir, "experiences.json"));
}

test("经验默认待审核，待审核经验不会注入上下文", async () => {
  const db = await store();
  await db.recordConversation({ userMessage: "怎么跟随玩家", assistantReply: "先识别附近玩家" });
  assert.equal(db.stats().pending, 1);
  assert.equal(db.contextFor("跟随玩家"), "");
});

test("明确正向反馈后经验可检索并持久化", async () => {
  const db = await store();
  const entry = await db.recordConversation({ userMessage: "挖矿前做什么", assistantReply: "先读取背包" });
  const approved = await db.applyFeedback({ id: entry.id, feedback: "positive", lesson: "挖矿前先识别背包工具" });
  assert.equal(approved.status, "approved");
  assert.match(db.contextFor("背包工具"), /挖矿前先识别背包工具/u);
  const raw = JSON.parse(await readFile(db.filePath, "utf8"));
  assert.equal(raw[0].status, "approved");
});

test("启用经验必须有规则，拒绝反馈会停用经验", async () => {
  const db = await store();
  const entry = await db.recordConversation({ userMessage: "问题", assistantReply: "回答" });
  await assert.rejects(() => db.setStatus(entry.id, "approved"), /经验规则/u);
  const disabled = await db.applyFeedback({ id: entry.id, feedback: "negative" });
  assert.equal(disabled.status, "disabled");
  assert.equal(db.search("问题").length, 0);
});

test("反馈命令只识别明确表达", () => {
  assert.deepEqual(parseExperienceFeedback("@MinecraftAI 记住这条：先观察", "MinecraftAI"), { feedback: "positive", lesson: "先观察" });
  assert.deepEqual(parseExperienceFeedback("@MinecraftAI 回答错了", "MinecraftAI"), { feedback: "negative", lesson: "" });
  assert.equal(parseExperienceFeedback("@MinecraftAI 这个方块对不对？", "MinecraftAI"), null);
  assert.equal(parseExperienceFeedback("@MinecraftAI 你觉得这个对吗？", "MinecraftAI"), null);
});
