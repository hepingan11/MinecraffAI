import test from "node:test";
import assert from "node:assert/strict";
import { AutoReplyService, DEFAULT_CONFIG } from "../auto-reply.mjs";

test("发给唤醒 ID 的本地私聊会触发，AI 发给其他玩家的回显会忽略", async () => {
  const sent = [];
  const service = new AutoReplyService({ chatSender: async (_window, message) => sent.push(message) });
  service.config = { ...DEFAULT_CONFIG, enabled: true, triggerName: "Guiwuli77", apiKey: "test" };
  service.selectTargetWindow = async () => ({ id: "window-1" });
  service.generateReply = async () => "收到啦";
  await service.processLine("[18:56:36] [Render thread/INFO]: [CHAT] [me -> [Guiwuli77 head]Guiwuli77] @Guiwuli77 love");
  await service.processLine("[18:56:37] [Render thread/INFO]: [CHAT] [me -> [lanlnde300 head]lanlnde300] @lanlnde300 已收到");
  assert.deepEqual(sent, ["收到啦"]);
});
