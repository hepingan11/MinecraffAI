const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是 JSON 对象");
      return parsed;
    } catch (error) {
      throw new Error(`工具参数不是有效 JSON：${error.message}`);
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("工具参数必须是 JSON 对象");
  return raw;
}

function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some((entry) => typeMatches(value, entry));
  switch (type) {
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "null": return value === null;
    default: return true;
  }
}

function validateSchema(value, schema, path = "参数") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    throw new Error(`${path} 必须等于 ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${path} 必须是 ${schema.enum.map((item) => JSON.stringify(item)).join("、")}`);
  }
  if (schema.oneOf) {
    const valid = schema.oneOf.some((candidate) => {
      try { validateSchema(value, candidate, path); return true; } catch { return false; }
    });
    if (!valid) throw new Error(`${path} 不符合任何允许的参数格式`);
  }
  if (schema.anyOf) {
    const valid = schema.anyOf.some((candidate) => {
      try { validateSchema(value, candidate, path); return true; } catch { return false; }
    });
    if (!valid) throw new Error(`${path} 不符合允许的参数格式`);
  }
  if (schema.type && !typeMatches(value, schema.type)) throw new Error(`${path} 类型无效，应为 ${Array.isArray(schema.type) ? schema.type.join("/ ") : schema.type}`);
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) throw new Error(`${path} 长度不能少于 ${schema.minLength}`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) throw new Error(`${path} 长度不能超过 ${schema.maxLength}`);
    if (schema.pattern) {
      let pattern;
      try { pattern = new RegExp(schema.pattern, "u"); } catch { throw new Error(`${path} 的校验规则无效`); }
      if (!pattern.test(value)) throw new Error(`${path} 格式无效`);
    }
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw new Error(`${path} 不能小于 ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw new Error(`${path} 不能大于 ${schema.maximum}`);
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) throw new Error(`${path} 必须大于 ${schema.exclusiveMinimum}`);
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) throw new Error(`${path} 必须小于 ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) throw new Error(`${path} 至少需要 ${schema.minItems} 项`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw new Error(`${path} 不能超过 ${schema.maxItems} 项`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }
  if (typeMatches(value, "object")) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!(required in value) || value[required] === undefined) throw new Error(`${path}.${required} 是必填参数`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value && value[key] !== undefined) validateSchema(value[key], child, `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) throw new Error(`${path}.${key} 不是允许的参数`);
    }
  }
}

/**
 * Backend-owned tool registry. The model only receives the public schemas;
 * handlers remain on the backend and must validate all arguments again.
 */
export class ToolRegistry {
  constructor({ maxTools = 64 } = {}) {
    this.maxTools = Number.isInteger(maxTools) && maxTools > 0 ? maxTools : 64;
    this.tools = new Map();
  }

  register({ name, description, parameters = { type: "object", properties: {}, additionalProperties: false }, handler, readOnly = false } = {}) {
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) throw new Error(`工具名无效：${name}`);
    if (this.tools.has(name)) throw new Error(`工具已注册：${name}`);
    if (this.tools.size >= this.maxTools) throw new Error(`工具数量不能超过 ${this.maxTools}`);
    if (typeof description !== "string" || !description.trim()) throw new Error(`工具 ${name} 缺少描述`);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error(`工具 ${name} 参数 schema 无效`);
    if (typeof handler !== "function") throw new Error(`工具 ${name} 缺少后端处理器`);
    this.tools.set(name, Object.freeze({ name, description: description.trim(), parameters: cloneJson(parameters), handler, readOnly: Boolean(readOnly) }));
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  /** Numen-style lenient lookup: exact spelling first, then ASCII case-insensitive. */
  resolve(name) {
    if (typeof name !== "string") return null;
    const exact = this.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    if (lower === name) return null;
    return this.get(lower) || this.list().find((tool) => tool.name.toLowerCase() === lower) || null;
  }

  remove(name) {
    const tool = this.resolve(name);
    if (!tool) return null;
    this.tools.delete(tool.name);
    return tool;
  }

  list() {
    return [...this.tools.values()];
  }

  definitions() {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: cloneJson(tool.parameters),
      },
    }));
  }

  async invoke(name, rawArguments, context = {}) {
    const tool = this.resolve(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    try {
      const args = normalizeArguments(rawArguments);
      validateSchema(args, tool.parameters, "工具参数");
      const result = await tool.handler(args, Object.freeze({ ...context, tool: tool.name, readOnly: tool.readOnly }));
      return result === undefined ? { ok: true } : result;
    } catch (error) {
      return { ok: false, executionError: error instanceof Error ? error.message : String(error) };
    }
  }
}

export { TOOL_NAME_PATTERN, normalizeArguments, validateSchema };
