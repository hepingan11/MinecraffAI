import test from "node:test";
import assert from "node:assert/strict";
import { AutoReplyService, DEFAULT_CONFIG } from "../auto-reply.mjs";
import { ToolRegistry } from "../tool-registry.mjs";

test("模型鉴权失败提供明确提示，停止对话且不执行工具；修正后可以再次触发", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const toolMode of [false, true]) {
      let executed = 0;
      const sent = [];
      const registry = new ToolRegistry();
      registry.register({
        name: "minecraft_inventory", description: "Read inventory",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => { executed++; return { ok: true }; },
      });
      const service = new AutoReplyService({
        toolRegistry: toolMode ? registry : null,
        chatSender: async (_window, message) => sent.push(message),
      });
      service.config = { ...DEFAULT_CONFIG, apiKey: "private-test-key", triggerName: "Guiwuli77" };
      service.selectTargetWindow = async () => ({ id: "test-window" });
      for (const body of ['{"error":{"message":"Invalid API key"}}', '<html>Unauthorized</html>']) {
        globalThis.fetch = async () => new Response(body, { status: 401 });
        await service.processChatEvent({ time: body, text: "<Alex> @Guiwuli77 hi" });
        assert.match(service.status.lastError, /文本模型 API 鉴权失败（HTTP 401）/u);
        assert.match(service.status.lastError, /自动回复.*Base URL.*不是语音 API Key/u);
        assert.doesNotMatch(service.status.lastError, /private-test-key/u);
        assert.equal(service.processing, false);
        assert.equal(service.status.replied, 0);
        assert.equal(executed, 0);
        assert.deepEqual(sent, []);
      }
      globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "你好" } }] });
      await service.processChatEvent({ time: "recovered", text: "<Alex> @Guiwuli77 hi" });
      assert.deepEqual(sent, ["你好"]);
      assert.equal(service.status.lastError, null);
      assert.equal(service.status.replied, 1);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
