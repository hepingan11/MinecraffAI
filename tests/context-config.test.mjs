import test from "node:test";
import assert from "node:assert/strict";
import { AutoReplyService, DEFAULT_CONFIG, MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES, normalizeConfig } from "../src/core/auto-reply.mjs";

test("后端校验上下文条数和字符数范围", () => {
  assert.equal(normalizeConfig({ contextMessages: 30, contextChars: 12000 }, { ...DEFAULT_CONFIG }).contextMessages, 30);
  assert.equal(normalizeConfig({ contextMessages: 30, contextChars: 12000 }, { ...DEFAULT_CONFIG }).contextChars, 12000);
  assert.throws(() => normalizeConfig({ contextMessages: 0 }, { ...DEFAULT_CONFIG }), /历史消息条数/u);
  assert.throws(() => normalizeConfig({ contextMessages: MAX_CONTEXT_MESSAGES + 1 }, { ...DEFAULT_CONFIG }), /历史消息条数/u);
  assert.throws(() => normalizeConfig({ contextChars: 255 }, { ...DEFAULT_CONFIG }), /历史上下文字符数/u);
  assert.throws(() => normalizeConfig({ contextChars: MAX_CONTEXT_CHARS + 1 }, { ...DEFAULT_CONFIG }), /历史上下文字符数/u);
  assert.equal(normalizeConfig({ executionMode: "commands" }, { ...DEFAULT_CONFIG }).executionMode, "commands");
  assert.throws(() => normalizeConfig({ executionMode: "shell" }, { ...DEFAULT_CONFIG }), /执行模式/u);
});

test("聊天上下文按配置动态限制，当前消息单独保留", () => {
  const service = new AutoReplyService();
  service.config = { ...DEFAULT_CONFIG, contextMessages: 2, contextChars: 80 };
  service.chatContext = [
    { time: "00:00:01", text: "旧消息一" },
    { time: "00:00:02", text: "旧消息二" },
    { time: "00:00:03", text: "旧消息三" },
  ];
  const context = service.conversationContext("当前问题");
  assert.doesNotMatch(context, /旧消息一/u);
  assert.match(context, /旧消息二/u);
  assert.match(context, /旧消息三/u);
  assert.match(context, /\[CURRENT_MESSAGE\] 当前问题/u);
  assert.ok(context.length <= 80 + "\n[CURRENT_MESSAGE] 当前问题".length);
});


test("experience learning toggle is backend validated and skips new records", async () => {
  assert.equal(DEFAULT_CONFIG.experienceLearningEnabled, true);
  assert.equal(normalizeConfig({ experienceLearningEnabled: false }, { ...DEFAULT_CONFIG }).experienceLearningEnabled, false);
  assert.throws(() => normalizeConfig({ experienceLearningEnabled: "false" }, { ...DEFAULT_CONFIG }));

  let records = 0;
  const service = new AutoReplyService({
    experienceStore: { recordConversation: async () => { records += 1; } },
    chatSender: async () => {},
  });
  service.config = { ...DEFAULT_CONFIG, enabled: true, apiKey: "test", experienceLearningEnabled: false };
  service.selectTargetWindow = async () => ({ id: "window-1" });
  service.generateReply = async () => "received";
  await service.processChatEvent({ time: "12:00:01", text: "Alex: @MinecraftAI hello" });
  assert.equal(records, 0);

  service.config.experienceLearningEnabled = true;
  service.lastReplyAt = 0;
  await service.processChatEvent({ time: "12:00:02", text: "Alex: @MinecraftAI goodbye" });
  assert.equal(records, 1);
});
