import test from "node:test";
import assert from "node:assert/strict";
import { AutoReplyService, DEFAULT_CONFIG, normalizeConfig } from "../src/core/auto-reply.mjs";
import { ToolRegistry } from "../src/core/tool-registry.mjs";
import { LLM_FORMATS, buildModelRequest, createProtocolState, modelEndpoint, modelHeaders } from "../src/core/llm-protocol.mjs";

function registry() {
  const tools = new ToolRegistry();
  tools.register({
    name: "minecraft_inventory",
    description: "Read inventory",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true, items: [{ itemId: "minecraft:stone", count: 3 }] }),
  });
  return tools;
}

test("LLM 协议端点、认证头和工具 schema 按格式转换", () => {
  assert.equal(modelEndpoint("https://api.openai.com/v1", LLM_FORMATS.CHAT_COMPLETIONS), "https://api.openai.com/v1/chat/completions");
  assert.equal(modelEndpoint("https://api.openai.com/v1", LLM_FORMATS.RESPONSES), "https://api.openai.com/v1/responses");
  assert.equal(modelEndpoint("https://api.anthropic.com/v1", LLM_FORMATS.ANTHROPIC), "https://api.anthropic.com/v1/messages");
  assert.equal(modelHeaders("secret", LLM_FORMATS.RESPONSES).Authorization, "Bearer secret");
  assert.equal(modelHeaders("secret", LLM_FORMATS.ANTHROPIC)["x-api-key"], "secret");
  assert.equal(modelHeaders("secret", LLM_FORMATS.ANTHROPIC).Authorization, undefined);

  const definitions = registry().definitions();
  const responsesBody = buildModelRequest({
    format: LLM_FORMATS.RESPONSES,
    model: "gpt-test",
    temperature: 0.2,
    maxTokens: 80,
    tools: definitions,
    state: createProtocolState(LLM_FORMATS.RESPONSES, "system", "hello"),
  });
  assert.equal(responsesBody.max_output_tokens, 80);
  assert.equal(responsesBody.tools[0].name, "minecraft_inventory");
  assert.equal(responsesBody.tools[0].parameters.type, "object");
  assert.equal(responsesBody.messages, undefined);

  const anthropicBody = buildModelRequest({
    format: LLM_FORMATS.ANTHROPIC,
    model: "claude-test",
    temperature: 0.2,
    maxTokens: 80,
    tools: definitions,
    state: createProtocolState(LLM_FORMATS.ANTHROPIC, "system", "hello"),
  });
  assert.equal(anthropicBody.max_tokens, 80);
  assert.equal(anthropicBody.tools[0].input_schema.type, "object");
  assert.equal(anthropicBody.messages[0].content[0].type, "text");
  assert.equal(normalizeConfig({ apiFormat: "responses" }).apiFormat, "responses");
  assert.equal(normalizeConfig({ apiFormat: "anthropic" }).apiFormat, "anthropic");
  assert.throws(() => normalizeConfig({ apiFormat: "unknown" }), /LLM|LLM|格式/u);
});

test("AI 接口检测暴露非 JSON 响应的端点和安全诊断信息", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => "<!doctype html><html><body>gateway</body></html>",
  });
  try {
    const service = new AutoReplyService();
    service.config = {
      ...DEFAULT_CONFIG,
      apiFormat: "anthropic",
      baseUrl: "https://gateway.example",
      apiKey: "secret-key",
      model: "claude-test",
    };
    const result = await service.checkModelConnection();
    assert.equal(result.endpoint, "https://gateway.example/messages");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.errorCode, "INVALID_JSON_RESPONSE");
    assert.equal(result.contentType, "text/html; charset=utf-8");
    assert.match(result.responsePreview, /doctype html/u);
    assert.match(result.error, /Base URL/u);
    assert.equal(JSON.stringify(result).includes("secret-key"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Anthropic 检测在模型弃用 temperature 时自动重试", async () => {
  const previousFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    if (payloads.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ message: "temperature is deprecated for this model" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ content: [{ type: "text", text: "OK" }] }),
    };
  };
  try {
    const service = new AutoReplyService();
    service.config = { ...DEFAULT_CONFIG, apiFormat: "anthropic", baseUrl: "https://gateway.example/v1", apiKey: "test-key", model: "claude-test" };
    const result = await service.checkModelConnection();
    assert.equal(result.available, true);
    assert.equal(payloads.length, 2);
    assert.equal(Object.hasOwn(payloads[0], "temperature"), true);
    assert.equal(Object.hasOwn(payloads[1], "temperature"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("OpenAI Responses API 支持 function_call -> function_call_output 的 ReAct 循环", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const body = requests.length === 1
      ? { output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "minecraft_inventory", arguments: "{}" }] }
      : { output_text: "已读取背包", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "已读取背包" }] }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const service = new AutoReplyService({ toolRegistry: registry() });
    service.config = { ...DEFAULT_CONFIG, apiFormat: "responses", baseUrl: "https://api.openai.com/v1", apiKey: "test-key", maxToolRounds: 2 };
    assert.equal(await service.generateReply("查一下背包", { id: "window-1" }), "已读取背包");
    assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
    assert.equal(requests[0].headers.Authorization, "Bearer test-key");
    assert.equal(requests[0].body.input[0].role, "user");
    assert.equal(requests[0].body.tools[0].name, "minecraft_inventory");
    assert.equal(requests[1].body.input.at(-1).type, "function_call_output");
    assert.equal(requests[1].body.input.at(-1).call_id, "call_1");
    assert.match(requests[1].body.input.at(-1).output, /minecraft:stone/u);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Anthropic Messages API 支持 tool_use -> tool_result 的 ReAct 循环", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const body = requests.length === 1
      ? { id: "msg_1", content: [{ type: "tool_use", id: "tool_1", name: "minecraft_inventory", input: {} }], stop_reason: "tool_use" }
      : { id: "msg_2", content: [{ type: "text", text: "已读取背包" }], stop_reason: "end_turn" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const service = new AutoReplyService({ toolRegistry: registry() });
    service.config = { ...DEFAULT_CONFIG, apiFormat: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key", model: "claude-test", maxToolRounds: 2 };
    assert.equal(await service.generateReply("查一下背包", { id: "window-1" }), "已读取背包");
    assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(requests[0].headers["x-api-key"], "test-key");
    assert.equal(requests[0].headers.Authorization, undefined);
    assert.equal(requests[0].body.system.length > 0, true);
    assert.equal(requests[0].body.tools[0].input_schema.type, "object");
    assert.equal(requests[1].body.messages.at(-2).role, "assistant");
    assert.equal(requests[1].body.messages.at(-2).content[0].type, "tool_use");
    assert.equal(requests[1].body.messages.at(-1).content[0].type, "tool_result");
    assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id, "tool_1");
    assert.match(requests[1].body.messages.at(-1).content[0].content, /minecraft:stone/u);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AI 接口检测返回协议、HTTP 状态和延迟，并且不返回模型文本或密钥", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "OK", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }),
    };
  };
  try {
    const service = new AutoReplyService();
    service.config = { ...DEFAULT_CONFIG, apiFormat: "responses", baseUrl: "https://api.openai.com/v1", apiKey: "stored-secret", model: "gpt-test" };
    const result = await service.checkModelConnection({ apiKey: "temporary-secret" });
    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.equal(result.protocol, "responses");
    assert.equal(result.httpStatus, 200);
    assert.equal(Number.isInteger(result.latencyMs), true);
    assert.equal(result.response, undefined);
    assert.equal(result.error, undefined);
    assert.equal(requests[0].headers.Authorization, "Bearer temporary-secret");
    assert.equal(requests[0].body.tools, undefined);
    assert.equal(requests[0].body.max_output_tokens, 32);
    assert.equal(JSON.stringify(result).includes("temporary-secret"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AI 接口检测在未配置 Key 时不发起网络请求", async () => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error("should not call"); };
  try {
    const service = new AutoReplyService();
    service.config = { ...DEFAULT_CONFIG, apiKey: "" };
    const result = await service.checkModelConnection();
    assert.equal(result.available, false);
    assert.match(result.error, /API Key/u);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
