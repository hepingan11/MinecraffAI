import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../core/project-paths.mjs";

const ROOT = PROJECT_ROOT;
const DEFAULT_DIR = path.join(ROOT, "data", "numen-bench");
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,99}$/u;
const SCENARIO_API_PATTERN = /numen\.(?:work|move|inv|build|scan)\./u;

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function array(value, field, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${field} must be an array`);
  return value;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function validatePosition(value, field) {
  const position = object(value, field);
  for (const axis of ["x", "y", "z"]) {
    if (!Number.isInteger(position[axis])) throw new Error(`${field}.${axis} must be an integer`);
  }
  return position;
}

function validateScenario(raw) {
  const scenario = object(raw, "scenario");
  if (scenario.schemaVersion !== 1) throw new Error("scenario.schemaVersion must be 1");
  const id = nonEmptyString(scenario.id, "scenario.id");
  if (!ID_PATTERN.test(id)) throw new Error("scenario.id is invalid");
  nonEmptyString(scenario.title, `${id}.title`);
  nonEmptyString(scenario.userGoal, `${id}.userGoal`);
  const source = object(scenario.source, `${id}.source`);
  nonEmptyString(source.project, `${id}.source.project`);
  nonEmptyString(source.gameVersion, `${id}.source.gameVersion`);
  nonEmptyString(source.scenarioClass, `${id}.source.scenarioClass`);
  nonEmptyString(source.sourceFile, `${id}.source.sourceFile`);
  nonEmptyString(scenario.targetGameVersion, `${id}.targetGameVersion`);

  const budget = object(scenario.budget, `${id}.budget`);
  for (const field of ["turns", "minutes"]) {
    if (!Number.isInteger(budget[field]) || budget[field] < 1) throw new Error(`${id}.budget.${field} must be positive`);
  }

  const initialState = object(scenario.initialState, `${id}.initialState`);
  const arena = object(initialState.arena, `${id}.initialState.arena`);
  for (const field of ["size", "height"]) {
    if (!Number.isInteger(arena[field]) || arena[field] < 1) throw new Error(`${id}.initialState.arena.${field} must be positive`);
  }
  const floor = object(arena.floor, `${id}.initialState.arena.floor`);
  nonEmptyString(floor.blockId, `${id}.initialState.arena.floor.blockId`);
  if (!Number.isInteger(floor.topY) || !Number.isInteger(floor.depth) || floor.depth < 1) {
    throw new Error(`${id}.initialState.arena.floor must define an integer topY and positive depth`);
  }
  const boundary = object(arena.boundary, `${id}.initialState.arena.boundary`);
  nonEmptyString(boundary.blockId, `${id}.initialState.arena.boundary.blockId`);
  if (!Number.isInteger(boundary.thickness) || boundary.thickness < 1) {
    throw new Error(`${id}.initialState.arena.boundary.thickness must be positive`);
  }
  const player = object(initialState.player, `${id}.initialState.player`);
  validatePosition(player.start, `${id}.initialState.player.start`);
  validatePosition(player.owner, `${id}.initialState.player.owner`);
  array(initialState.inventory, `${id}.initialState.inventory`).forEach((item, index) => {
    const entry = object(item, `${id}.initialState.inventory[${index}]`);
    nonEmptyString(entry.itemId, `${id}.initialState.inventory[${index}].itemId`);
    if (!Number.isInteger(entry.count) || entry.count < 0) throw new Error(`${id}.initialState.inventory[${index}].count must be non-negative`);
  });
  const world = object(initialState.world, `${id}.initialState.world`);
  array(world.fills, `${id}.initialState.world.fills`).forEach((fill, index) => {
    const entry = object(fill, `${id}.initialState.world.fills[${index}]`);
    validatePosition(entry.from, `${id}.initialState.world.fills[${index}].from`);
    validatePosition(entry.to, `${id}.initialState.world.fills[${index}].to`);
    nonEmptyString(entry.blockId, `${id}.initialState.world.fills[${index}].blockId`);
  });
  array(world.blocks, `${id}.initialState.world.blocks`).forEach((block, index) => {
    const entry = object(block, `${id}.initialState.world.blocks[${index}]`);
    validatePosition(entry.pos, `${id}.initialState.world.blocks[${index}].pos`);
    nonEmptyString(entry.blockId, `${id}.initialState.world.blocks[${index}].blockId`);
  });

  const goals = object(scenario.goals, `${id}.goals`);
  array(goals.success, `${id}.goals.success`, 1);
  array(goals.subgoals, `${id}.goals.subgoals`);
  if (goals.guards !== undefined) array(goals.guards, `${id}.goals.guards`);
  array(scenario.referencePlan, `${id}.referencePlan`, 1).forEach((step, index) => {
    const entry = object(step, `${id}.referencePlan[${index}]`);
    nonEmptyString(entry.phase, `${id}.referencePlan[${index}].phase`);
    if (entry.actionKinds !== undefined) array(entry.actionKinds, `${id}.referencePlan[${index}].actionKinds`);
  });
  array(scenario.requiredCapabilities, `${id}.requiredCapabilities`);
  array(scenario.failureCases, `${id}.failureCases`);
  object(scenario.migration, `${id}.migration`);

  const serialized = JSON.stringify(scenario);
  if (SCENARIO_API_PATTERN.test(serialized)) {
    throw new Error(`${id} contains a Numen runtime API call; store abstract action kinds instead`);
  }
  return scenario;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`读取 ${label} 失败：${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
}

export async function loadNumenBenchIndex(directory = DEFAULT_DIR) {
  const index = await readJson(path.join(directory, "index.json"), "Numen Bench index");
  object(index, "index");
  if (index.schemaVersion !== 1) throw new Error("Numen Bench index.schemaVersion must be 1");
  array(index.scenarios, "index.scenarios", 1).forEach((entry, position) => {
    object(entry, `index.scenarios[${position}]`);
    const id = nonEmptyString(entry.id, `index.scenarios[${position}].id`);
    if (!ID_PATTERN.test(id)) throw new Error(`index.scenarios[${position}].id is invalid`);
    nonEmptyString(entry.file, `index.scenarios[${position}].file`);
  });
  return index;
}

export async function loadNumenBenchScenario(id, directory = DEFAULT_DIR) {
  const normalizedId = nonEmptyString(id, "scenario id");
  if (!ID_PATTERN.test(normalizedId)) throw new Error("scenario id is invalid");
  const index = await loadNumenBenchIndex(directory);
  const entry = index.scenarios.find((item) => item.id === normalizedId);
  if (!entry) throw new Error(`Numen Bench 场景不存在：${normalizedId}`);
  const scenario = validateScenario(await readJson(path.join(directory, entry.file), entry.file));
  if (scenario.id !== normalizedId) throw new Error(`${entry.file} 的 id 与 index 不一致`);
  return scenario;
}

export async function loadAllNumenBenchScenarios(directory = DEFAULT_DIR) {
  const index = await loadNumenBenchIndex(directory);
  return Promise.all(index.scenarios.map((entry) => loadNumenBenchScenario(entry.id, directory)));
}

export { DEFAULT_DIR, validateScenario };
