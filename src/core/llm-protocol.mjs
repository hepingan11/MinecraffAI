const LLM_FORMATS = Object.freeze({
  CHAT_COMPLETIONS: "chat_completions",
  RESPONSES: "responses",
  ANTHROPIC: "anthropic",
});

const MAX_COMMAND_FEEDBACK_CHARS = 30_000;
const SUPPORTED_FORMATS = new Set(Object.values(LLM_FORMATS));
const FORMAT_ALIASES = new Map([
  ["openai_chat_completions", LLM_FORMATS.CHAT_COMPLETIONS],
  ["openai_responses", LLM_FORMATS.RESPONSES],
  ["anthropic_messages", LLM_FORMATS.ANTHROPIC],
]);

function normalizeText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

export function normalizeLlmFormat(value) {
  const raw = String(value ?? LLM_FORMATS.CHAT_COMPLETIONS).trim().toLowerCase();
  const format = FORMAT_ALIASES.get(raw) || raw;
  if (!SUPPORTED_FORMATS.has(format)) throw new Error(`不支持的 LLM 接口格式：${format}`);
  return format;
}

function stripKnownPath(baseUrl) {
  return String(baseUrl).replace(/\/(?:chat\/completions|responses|messages)$/iu, "");
}

export function modelEndpoint(baseUrl, format) {
  const normalized = normalizeLlmFormat(format);
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/u, "");
  const root = stripKnownPath(normalizedBaseUrl);
  if (normalized === LLM_FORMATS.RESPONSES) return /\/responses$/iu.test(normalizedBaseUrl) ? normalizedBaseUrl : `${root}/responses`;
  if (normalized === LLM_FORMATS.ANTHROPIC) return /\/messages$/iu.test(normalizedBaseUrl) ? normalizedBaseUrl : `${root}/messages`;
  return /\/chat\/completions$/iu.test(normalizedBaseUrl) ? normalizedBaseUrl : `${root}/chat/completions`;
}

export function modelHeaders(apiKey, format) {
  const normalized = normalizeLlmFormat(format);
  const common = { "Content-Type": "application/json", Accept: "application/json" };
  if (normalized === LLM_FORMATS.ANTHROPIC) {
    return { ...common, "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { ...common, Authorization: `Bearer ${apiKey}` };
}

function responsesTools(definitions) {
  return (Array.isArray(definitions) ? definitions : []).map((definition) => {
    const fn = definition?.function || {};
    return {
      type: "function",
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {}, additionalProperties: false },
    };
  });
}

function anthropicTools(definitions) {
  return (Array.isArray(definitions) ? definitions : []).map((definition) => {
    const fn = definition?.function || {};
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {}, additionalProperties: false },
    };
  });
}

function anthropicTextMessage(message) {
  if (typeof message?.content === "string") return { ...message, content: [{ type: "text", text: message.content }] };
  return message;
}

export function createProtocolState(format, systemText, userText) {
  const normalized = normalizeLlmFormat(format);
  normalizeText(systemText, "system prompt");
  normalizeText(userText, "user message");
  if (normalized === LLM_FORMATS.RESPONSES) {
    return {
      format: normalized,
      instructions: systemText,
      input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
    };
  }
  if (normalized === LLM_FORMATS.ANTHROPIC) {
    return {
      format: normalized,
      system: systemText,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    };
  }
  return {
    format: normalized,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userText },
    ],
  };
}

export function buildModelRequest({ format, model, temperature, maxTokens, tools = [], state }) {
  const normalized = normalizeLlmFormat(format);
  const body = { model, temperature };
  if (normalized === LLM_FORMATS.RESPONSES) {
    const request = {
      ...body,
      max_output_tokens: maxTokens,
      instructions: state.instructions,
      input: state.input,
    };
    if (tools.length) Object.assign(request, { tools: responsesTools(tools), tool_choice: "auto" });
    return request;
  }
  if (normalized === LLM_FORMATS.ANTHROPIC) {
    const request = {
      ...body,
      max_tokens: maxTokens,
      system: state.system,
      messages: state.messages.map(anthropicTextMessage),
    };
    if (tools.length) Object.assign(request, { tools: anthropicTools(tools), tool_choice: { type: "auto" } });
    return request;
  }
  const request = {
    ...body,
    max_tokens: maxTokens,
    messages: state.messages,
  };
  if (tools.length) Object.assign(request, { tools, tool_choice: "auto" });
  return request;
}

function serializeArguments(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

function normalizeToolCall(id, name, args, index) {
  return {
    id: typeof id === "string" && id.trim() ? id : `tool_call_${index + 1}`,
    type: "function",
    function: {
      name: String(name || ""),
      arguments: serializeArguments(args),
    },
  };
}

function textFromBlocks(blocks, types) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => types.has(block?.type))
    .map((block) => typeof block?.text === "string" ? block.text : "")
    .join("");
}

export function parseModelTurn(body, format) {
  const normalized = normalizeLlmFormat(format);
  if (normalized === LLM_FORMATS.RESPONSES) {
    const output = Array.isArray(body?.output) ? body.output : [];
    const toolCalls = output
      .filter((item) => item?.type === "function_call")
      .map((item, index) => normalizeToolCall(item.call_id || item.id, item.name, item.arguments, index));
    const text = typeof body?.output_text === "string"
      ? body.output_text
      : output.filter((item) => item?.type === "message").flatMap((item) => item.content || [])
        .map((block) => typeof block?.text === "string" ? block.text : "").join("");
    return { text, toolCalls, assistantOutput: output };
  }
  if (normalized === LLM_FORMATS.ANTHROPIC) {
    const content = Array.isArray(body?.content) ? body.content : [];
    const toolCalls = content
      .filter((block) => block?.type === "tool_use")
      .map((block, index) => normalizeToolCall(block.id, block.name, block.input, index));
    return { text: textFromBlocks(content, new Set(["text"])), toolCalls, assistantContent: content };
  }
  const message = body?.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call, index) => normalizeToolCall(call?.id, call?.function?.name, call?.function?.arguments, index))
    : [];
  const content = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content) ? message.content.map((item) => item?.text || "").join("") : "";
  return { text: content, toolCalls, assistantMessage: message || { role: "assistant", content: null } };
}

export function appendAssistantTurn(state, turn) {
  if (state.format === LLM_FORMATS.RESPONSES) {
    state.input.push(...(Array.isArray(turn.assistantOutput) ? turn.assistantOutput : []));
    return;
  }
  if (state.format === LLM_FORMATS.ANTHROPIC) {
    state.messages.push({ role: "assistant", content: turn.assistantContent || [] });
    return;
  }
  state.messages.push({
    role: "assistant",
    content: turn.assistantMessage?.content ?? null,
    ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
  });
}

export function appendToolResults(state, results) {
  if (state.format === LLM_FORMATS.RESPONSES) {
    for (const item of results) state.input.push({ type: "function_call_output", call_id: item.call.id, output: item.serialized });
    return;
  }
  if (state.format === LLM_FORMATS.ANTHROPIC) {
    state.messages.push({
      role: "user",
      content: results.map((item) => ({ type: "tool_result", tool_use_id: item.call.id, content: item.serialized })),
    });
    return;
  }
  for (const item of results) state.messages.push({ role: "tool", tool_call_id: item.call.id, content: item.serialized });
}

export function appendCommandFeedback(state, results) {
  let serialized = JSON.stringify(results);
  if (typeof serialized !== "string") serialized = "[]";
  if (serialized.length > MAX_COMMAND_FEEDBACK_CHARS) {
    const retained = Array.isArray(results) ? results.slice(-32) : [];
    const total = Array.isArray(results) ? results.length : 0;
    serialized = JSON.stringify({ truncated: true, omitted: Math.max(0, total - retained.length), results: retained });
  }
  const content = `<command_results>\n${serialized}\n</command_results>`;
  if (state.format === LLM_FORMATS.RESPONSES) {
    state.input.push({ role: "user", content: [{ type: "input_text", text: content }] });
    return;
  }
  if (state.format === LLM_FORMATS.ANTHROPIC) {
    state.messages.push({ role: "user", content: [{ type: "text", text: content }] });
    return;
  }
  state.messages.push({ role: "user", content });
}

export { LLM_FORMATS };
