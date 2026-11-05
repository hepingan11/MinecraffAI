import { normalizeArguments, validateSchema } from "./tool-registry.mjs";

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u;
const PATH_PATTERN = /^(?:vars|last|results)(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/u;
const REFERENCE_PATTERN = /^\$((?:vars|last|results)(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*)$/u;
const DEFAULT_MAX_COMMANDS = 16;
const DEFAULT_MAX_STEPS = 256;
const MAX_ITERATIONS = 64;
const MAX_SCRIPT_DEPTH = 8;
const MAX_VARIABLES = 64;
const RESERVED_VARIABLE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** The model-facing command language maps only to backend-owned handlers. */
export const COMMAND_TO_TOOL = Object.freeze({
  observe: "minecraft_observe",
  inventory: "minecraft_inventory",
  environment: "minecraft_environment",
  scan_blocks: "minecraft_scan_blocks",
  move_to: "minecraft_move_to",
  break_block: "minecraft_break_block",
  place_block: "minecraft_place_block",
  recipes: "minecraft_recipes",
  craft: "minecraft_craft",
  mining: "minecraft_mining",
  explore_for_ore: "minecraft_explore_for_ore",
  chop_tree: "minecraft_chop_tree",
  blueprints: "minecraft_blueprints",
  build_blueprint: "minecraft_build_blueprint",
  build_status: "minecraft_build_status",
  build_stop: "minecraft_build_stop",
  players: "minecraft_players",
  follow: "minecraft_follow",
  teleport: "minecraft_teleport",
  tasks: "minecraft_tasks",
});

export const CONTROL_COMMANDS = Object.freeze(["set", "if", "repeat_until", "repeat_while"]);
const COMMANDS = Object.freeze(Object.keys(COMMAND_TO_TOOL));
const ALL_COMMANDS = Object.freeze([...COMMANDS, ...CONTROL_COMMANDS]);
const COMPARATORS = new Set(["equals", "notEquals", "gt", "gte", "lt", "lte", "contains", "in", "truthy", "falsy"]);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripFence(value) {
  const source = text(value);
  const fenced = source.match(/^```(?:json|mc|minecraft)?\s*([\s\S]*?)\s*```$/iu);
  return fenced ? fenced[1].trim() : source;
}

function parseJson(value) {
  const source = stripFence(value);
  try {
    return JSON.parse(source);
  } catch (error) {
    const first = source.indexOf("{");
    const last = source.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return JSON.parse(source.slice(first, last + 1)); } catch { /* report the original format below */ }
    }
    throw new Error(`命令流必须是 JSON：${error.message}`);
  }
}

function commandId(raw, path) {
  const id = text(raw?.id) || `command_${path}`;
  if (id.length > 120) throw new Error(`命令 ${path} 的 ID 过长`);
  return id;
}

function hasReference(value) {
  if (typeof value === "string") return REFERENCE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(hasReference);
  if (value && typeof value === "object") return Object.values(value).some(hasReference);
  return false;
}

function normalizePath(value, label) {
  const path = text(value).replace(/^\$/u, "");
  if (!PATH_PATTERN.test(path)) throw new Error(`${label} 只能引用 vars、last 或 results 路径`);
  return path;
}

function normalizeCondition(raw, path = "condition", depth = 0) {
  if (depth > MAX_SCRIPT_DEPTH) throw new Error(`${path} 嵌套层级过深`);
  if (typeof raw === "boolean") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} 必须是布尔值或条件对象`);
  const keys = Object.keys(raw);
  if (keys.includes("and") || keys.includes("or")) {
    if (keys.length !== 1) throw new Error(`${path} 逻辑条件不能包含其他字段`);
    const op = keys[0];
    if (!Array.isArray(raw[op]) || raw[op].length < 1 || raw[op].length > 8) throw new Error(`${path}.${op} 必须包含 1 到 8 项`);
    return { [op]: raw[op].map((item, index) => normalizeCondition(item, `${path}.${op}[${index}]`, depth + 1)) };
  }
  if (keys.length === 1 && keys[0] === "not") return { not: normalizeCondition(raw.not, `${path}.not`, depth + 1) };
  if (typeof raw.path !== "string") throw new Error(`${path}.path 必须是状态路径`);
  const normalizedPath = normalizePath(raw.path, `${path}.path`);
  const comparatorKeys = keys.filter((key) => key !== "path");
  if (comparatorKeys.length === 0) return { path: normalizedPath, truthy: true };
  if (comparatorKeys.length !== 1 || !COMPARATORS.has(comparatorKeys[0])) throw new Error(`${path} 比较条件无效`);
  const comparator = comparatorKeys[0];
  if (["truthy", "falsy"].includes(comparator) && typeof raw[comparator] !== "boolean") throw new Error(`${path}.${comparator} 必须是布尔值`);
  if (comparator === "in" && (!Array.isArray(raw.in) || raw.in.length > 64)) throw new Error(`${path}.in 必须是最多 64 项的数组`);
  return { path: normalizedPath, [comparator]: clone(raw[comparator]) };
}

function normalizeCommand(raw, path, registry, maxCommands, depth = 0) {
  if (depth > MAX_SCRIPT_DEPTH) throw new Error(`命令 ${path} 嵌套层级过深`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`命令 ${path} 必须是对象`);
  const op = text(raw.op || raw.command).toLowerCase();
  if (!COMMAND_NAME_PATTERN.test(op) || !ALL_COMMANDS.includes(op)) throw new Error(`不支持的 Minecraft 命令：${op || "(empty)"}`);
  const id = commandId(raw, path);
  if (op === "set") {
    const name = text(raw.name);
    if (!VARIABLE_NAME_PATTERN.test(name) || RESERVED_VARIABLE_NAMES.has(name)) throw new Error(`命令 ${path}.name 变量名无效`);
    if (!Object.prototype.hasOwnProperty.call(raw, "value")) throw new Error(`命令 ${path}.value 是必填参数`);
    return Object.freeze({ id, op, name, value: clone(raw.value) });
  }
  if (op === "if") {
    const thenCommands = normalizeCommandList(raw.then, `${path}.then`, registry, maxCommands, depth + 1);
    const elseCommands = raw.else === undefined ? [] : normalizeCommandList(raw.else, `${path}.else`, registry, maxCommands, depth + 1);
    return Object.freeze({ id, op, condition: normalizeCondition(raw.condition, `${path}.condition`), then: thenCommands, else: elseCommands });
  }
  if (["repeat_until", "repeat_while"].includes(op)) {
    const maxIterations = Number(raw.maxIterations);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_ITERATIONS) throw new Error(`命令 ${path}.maxIterations 必须在 1 到 ${MAX_ITERATIONS} 之间`);
    const steps = normalizeCommandList(raw.steps, `${path}.steps`, registry, maxCommands, depth + 1);
    if (!steps.length) throw new Error(`命令 ${path}.steps 不能为空`);
    return Object.freeze({ id, op, condition: normalizeCondition(raw.condition, `${path}.condition`), maxIterations, steps });
  }
  const tool = COMMAND_TO_TOOL[op];
  if (!registry?.has?.(tool)) throw new Error(`命令 ${op} 尚未注册后端执行器`);
  const rawArguments = raw.args ?? raw.arguments ?? {};
  const args = normalizeArguments(rawArguments);
  // Literal arguments can be rejected before execution. References are
  // resolved later, then ToolRegistry validates the resolved values again.
  if (!hasReference(args)) validateSchema(args, registry.get(tool)?.parameters, "命令参数");
  return Object.freeze({ id, op, tool, arguments: clone(args) });
}

function normalizeCommandList(raw, path, registry, maxCommands, depth) {
  if (!Array.isArray(raw)) throw new Error(`${path} 必须是数组`);
  if (raw.length > maxCommands) throw new Error(`${path} 不能超过 ${maxCommands} 条命令`);
  return raw.map((command, index) => normalizeCommand(command, `${path}[${index}]`, registry, maxCommands, depth));
}

/** Parse the strict model envelope used by command mode. */
export function parseCommandEnvelope(raw, { registry, maxCommands = DEFAULT_MAX_COMMANDS } = {}) {
  if (!registry || typeof registry.has !== "function") throw new Error("解析命令流需要后端工具注册表");
  if (!Number.isInteger(maxCommands) || maxCommands < 1 || maxCommands > 64) throw new Error("命令流批次上限无效");
  const envelope = parseJson(raw);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("命令流顶层必须是对象");
  const rawCommands = envelope.commands === undefined ? [] : envelope.commands;
  const commands = normalizeCommandList(rawCommands, "commands", registry, maxCommands, 0);
  const reply = text(envelope.reply);
  if (reply.length > 256) throw new Error("命令流 reply 不能超过 256 个字符");
  if (!commands.length && !reply) throw new Error("命令流必须包含 commands 或 reply");
  return Object.freeze({ commands, reply, raw: clone(envelope) });
}

export function commandProtocolInstructions() {
  return [
    "You are operating Minecraft through a backend command stream. This JSON protocol overrides any request to answer with plain text while an action is still needed.",
    `When an action or live fact is needed, output only JSON in this shape: {"commands":[{"op":"observe","args":{}}],"reply":""}.`,
    "Primitive commands run one at a time. Use set to save values, if for a bounded branch, repeat_until to stop when a condition becomes true, and repeat_while for a bounded loop.",
    "Conditions use only JSON objects such as {\"path\":\"last.result.ok\",\"equals\":true}, {\"path\":\"vars.count\",\"gte\":8}, {\"and\":[...]}, {\"or\":[...]}, and {\"not\":{...}}.",
    "Reference earlier data with exact strings such as $vars.target, $last.result.position.x, or $results[0].result.state. Never invent a reference that has not been set or returned.",
    "When the task is complete or the user only asks a question, output {\"commands\":[],\"reply\":\"...\"}.",
    `Allowed primitive commands: ${COMMANDS.join(", ")}. Allowed control commands: ${CONTROL_COMMANDS.join(", ")}. Do not output shell commands, JavaScript, Python, Markdown, or unknown operations.`,
    "Arguments, conditions, loop counts and variable references are checked by the backend. Never claim success without a successful command result.",
  ].join("\n");
}

function pathParts(path) {
  return path.match(/[a-zA-Z_][a-zA-Z0-9_]*|\d+/gu) || [];
}

function readPath(scope, path) {
  let current = scope;
  for (const part of pathParts(path)) {
    if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(Object(current), part)) throw new Error(`状态引用不存在：${path}`);
    current = current[part];
  }
  return current;
}

function resolveValue(value, scope) {
  if (typeof value === "string") {
    const reference = value.match(REFERENCE_PATTERN);
    return reference ? clone(readPath(scope, reference[1])) : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]));
  return value;
}

function compareCondition(value, comparator, expected) {
  switch (comparator) {
    case "equals": return JSON.stringify(value) === JSON.stringify(expected);
    case "notEquals": return JSON.stringify(value) !== JSON.stringify(expected);
    case "gt": return typeof value === "number" && value > expected;
    case "gte": return typeof value === "number" && value >= expected;
    case "lt": return typeof value === "number" && value < expected;
    case "lte": return typeof value === "number" && value <= expected;
    case "contains": return Array.isArray(value) ? value.some((item) => JSON.stringify(item) === JSON.stringify(expected)) : typeof value === "string" && value.includes(String(expected));
    case "in": return Array.isArray(expected) && expected.some((item) => JSON.stringify(item) === JSON.stringify(value));
    case "truthy": return Boolean(value) === expected;
    case "falsy": return !value === expected;
    default: throw new Error(`不支持的条件比较器：${comparator}`);
  }
}

function evaluateCondition(condition, scope) {
  if (typeof condition === "boolean") return condition;
  if (Array.isArray(condition) || !condition || typeof condition !== "object") throw new Error("条件格式无效");
  if (condition.and) return condition.and.every((item) => evaluateCondition(item, scope));
  if (condition.or) return condition.or.some((item) => evaluateCondition(item, scope));
  if (condition.not) return !evaluateCondition(condition.not, scope);
  const value = readPath(scope, condition.path);
  const comparator = Object.keys(condition).find((key) => key !== "path");
  return compareCondition(value, comparator, resolveValue(condition[comparator], scope));
}

export class CommandRuntime {
  constructor({ registry, executor, maxCommands = DEFAULT_MAX_COMMANDS, maxSteps = DEFAULT_MAX_STEPS } = {}) {
    if (!registry || typeof registry.has !== "function") throw new Error("CommandRuntime 需要 ToolRegistry");
    if (!executor || typeof executor.run !== "function") throw new Error("CommandRuntime 需要 ToolExecutor");
    if (!Number.isInteger(maxCommands) || maxCommands < 1 || maxCommands > 64) throw new Error("命令流批次上限无效");
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 4096) throw new Error("命令脚本步数上限无效");
    this.registry = registry;
    this.executor = executor;
    this.maxCommands = maxCommands;
    this.maxSteps = maxSteps;
  }

  async run(commands, context = {}, hooks = {}) {
    const normalized = normalizeCommandList(commands, "commands", this.registry, this.maxCommands, 0);
    const state = { variables: clone(context.variables || {}), records: [], last: null, steps: 0, cancelled: false, halted: false };
    if (Object.keys(state.variables).length > MAX_VARIABLES) throw new Error(`变量数量不能超过 ${MAX_VARIABLES}`);
    await this.executeList(normalized, context, hooks, state, 0);
    return state.records;
  }

  scope(state) {
    return { vars: state.variables, last: state.last, results: state.records };
  }

  addRecord(state, command, result, metadata = {}) {
    const record = { command, result, ...metadata };
    state.records.push(record);
    state.last = record;
    return record;
  }

  async executeList(commands, context, hooks, state, depth) {
    if (depth > MAX_SCRIPT_DEPTH) throw new Error("命令脚本嵌套层级过深");
    for (const command of commands) {
      if (state.cancelled || state.halted) break;
      state.steps += 1;
      if (state.steps > this.maxSteps) throw new Error(`命令脚本总执行步数不能超过 ${this.maxSteps}`);
      if (COMMAND_TO_TOOL[command.op]) {
        await this.executePrimitive(command, context, hooks, state);
      } else if (command.op === "set") {
        if (!Object.prototype.hasOwnProperty.call(state.variables, command.name) && Object.keys(state.variables).length >= MAX_VARIABLES) throw new Error(`变量数量不能超过 ${MAX_VARIABLES}`);
        const value = resolveValue(command.value, this.scope(state));
        state.variables[command.name] = clone(value);
        this.addRecord(state, { id: command.id, op: command.op, name: command.name }, { ok: true, variable: command.name, value: clone(value) });
      } else if (command.op === "if") {
        const matched = evaluateCondition(command.condition, this.scope(state));
        this.addRecord(state, { id: command.id, op: command.op }, { ok: true, branch: matched ? "then" : "else", matched });
        await this.executeList(matched ? command.then : command.else, context, hooks, state, depth + 1);
      } else if (["repeat_until", "repeat_while"].includes(command.op)) {
        await this.executeLoop(command, context, hooks, state, depth + 1);
      }
    }
  }

  async executeLoop(command, context, hooks, state, depth) {
    let iterations = 0;
    let conditionMet = evaluateCondition(command.condition, this.scope(state));
    while (!state.cancelled && iterations < command.maxIterations && (command.op === "repeat_until" ? !conditionMet : conditionMet)) {
      await this.executeList(command.steps, context, hooks, state, depth);
      iterations += 1;
      conditionMet = evaluateCondition(command.condition, this.scope(state));
    }
    const completed = command.op === "repeat_until" ? conditionMet : !conditionMet;
    this.addRecord(state, { id: command.id, op: command.op }, {
      ok: completed,
      iterations,
      conditionMet,
      ...(completed ? {} : { executionError: `循环达到 ${command.maxIterations} 次上限` }),
    });
    if (!completed) state.halted = true;
  }

  async executePrimitive(command, context, hooks, state) {
    const argumentsValue = resolveValue(command.arguments, this.scope(state));
    const resolvedCommand = Object.freeze({ ...command, arguments: argumentsValue });
    const [item] = await this.executor.run([{
      id: command.id,
      name: command.tool,
      arguments: argumentsValue,
      command: resolvedCommand,
    }], { ...context, variables: clone(state.variables), commandState: this.scope(state) }, hooks);
    const record = this.addRecord(state, resolvedCommand, item.result, {
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      cancelled: Boolean(item.cancelled || item.result?.cancelled),
    });
    if (record.cancelled) state.cancelled = true;
  }
}

export { ALL_COMMANDS, COMMANDS, DEFAULT_MAX_COMMANDS, DEFAULT_MAX_STEPS, MAX_ITERATIONS, normalizeCommand, normalizeCondition, resolveValue, evaluateCondition };
