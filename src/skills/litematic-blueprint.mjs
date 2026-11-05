import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import nbt from "prismarine-nbt";
import { PROJECT_ROOT } from "../core/project-paths.mjs";

const DEFAULT_BLUEPRINT_DIR = path.join(PROJECT_ROOT, "data", "blueprints");
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REGION_CELLS = 8_000_000;
const DEFAULT_MAX_BLOCKS = 32_768;
const BLOCK_ID = /^minecraft:[a-z0-9_./-]+$/u;
const BLUEPRINT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,127}\.litematic$/u;

function integer(value, name) {
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error(`${name} 必须是整数`);
  return result;
}

function dimension(value, name) {
  const result = integer(value, name);
  if (result === 0) throw new Error(`${name} 不能为 0`);
  return result;
}

function safeBlueprintName(name) {
  let result = String(name ?? "").trim();
  if (!result) throw new Error("蓝图名称不能为空");
  if (!result.toLowerCase().endsWith(".litematic")) result += ".litematic";
  if (!BLUEPRINT_NAME_PATTERN.test(result)) {
    throw new Error("蓝图名称只能包含 Unicode 字母、数字（包括中文）、下划线、点和短横线，并且必须是 .litematic");
  }
  return result;
}

function blueprintDirectories(directory) {
  if (directory !== undefined && directory !== null) return [path.resolve(String(directory))];
  const configured = process.env.MC_AI_BLUEPRINT_DIRS || process.env.MC_AI_BLUEPRINT_DIR;
  const values = configured ? configured.split(path.delimiter).map((value) => value.trim()).filter(Boolean) : [DEFAULT_BLUEPRINT_DIR];
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function childPath(root, filename) {
  const resolved = path.resolve(root, filename);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("蓝图路径越界");
  return resolved;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 格式无效`);
  return value;
}

function asBlockId(value, name) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!BLOCK_ID.test(result)) throw new Error(`${name} 不是有效 Minecraft 方块 ID`);
  return result;
}

function coordinates(value, name) {
  const source = object(value, name);
  return { x: integer(source.x, `${name}.x`), y: integer(source.y, `${name}.y`), z: integer(source.z, `${name}.z`) };
}

function absoluteRegionOrigin(position, size) {
  return {
    x: position.x + (size.x < 0 ? size.x + 1 : 0),
    y: position.y + (size.y < 0 ? size.y + 1 : 0),
    z: position.z + (size.z < 0 ? size.z + 1 : 0),
  };
}

function paletteBlock(entry, index, regionName) {
  const source = object(entry, `Regions.${regionName}.BlockStatePalette[${index}]`);
  const id = asBlockId(source.Name, `Regions.${regionName}.BlockStatePalette[${index}].Name`);
  const properties = source.Properties && typeof source.Properties === "object" ? source.Properties : {};
  const stateEntries = Object.entries(properties).filter(([key, value]) => /^[a-z0-9_]+$/u.test(key) && /^[a-z0-9_]+$/u.test(String(value)));
  const state = stateEntries.length
    ? `${id}[${stateEntries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(",")}]`
    : id;
  return { id, state };
}

function longWords(value) {
  if (!Array.isArray(value)) throw new Error("BlockStates 必须是 LongArray");
  return value.map((item) => BigInt(item));
}

function paletteIndex(words, index, bits) {
  const start = BigInt(index * bits);
  const word = Number(start / 64n);
  const offset = Number(start % 64n);
  const mask = (1n << BigInt(bits)) - 1n;
  let value = (words[word] ?? 0n) >> BigInt(offset);
  const remaining = offset + bits - 64;
  if (remaining > 0) value |= (words[word + 1] ?? 0n) << BigInt(bits - remaining);
  return Number(value & mask);
}

function rotate(x, z, rotation) {
  switch (rotation) {
    case 90: return { x: -z, z: x };
    case 180: return { x: -x, z: -z };
    case 270: return { x: z, z: -x };
    default: return { x, z };
  }
}

function normalizeRotation(value) {
  const result = integer(value ?? 0, "rotation");
  if (![0, 90, 180, 270].includes(result)) throw new Error("rotation 必须是 0、90、180 或 270");
  return result;
}

/** Read a Litematica .litematic file into a bounded, server-approved target list. */
export async function readLitematic(name, { directory, origin = { x: 0, y: 0, z: 0 }, rotation = 0, maxBlocks = DEFAULT_MAX_BLOCKS } = {}) {
  const filename = safeBlueprintName(name);
  const roots = blueprintDirectories(directory);
  let file;
  let info;
  for (const root of roots) {
    const candidate = childPath(root, filename);
    try {
      const candidateInfo = await stat(candidate);
      if (!candidateInfo.isFile()) continue;
      file = candidate;
      info = candidateInfo;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!file || !info) throw new Error(`找不到蓝图：${filename}（已搜索：${roots.join("；")}）。请设置 MC_AI_BLUEPRINT_DIR 或 MC_AI_BLUEPRINT_DIRS 指向 .litematic 所在目录`);
  if (!info.isFile()) throw new Error("蓝图路径不是文件");
  if (info.size > MAX_FILE_BYTES) throw new Error(`蓝图文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const parsed = await nbt.parse(await readFile(file));
  const simple = object(nbt.simplify(parsed.parsed), "Litematic 根节点");
  const regions = object(simple.Regions, "Litematic Regions");
  const anchor = coordinates(origin, "origin");
  const turn = normalizeRotation(rotation);
  const limit = integer(maxBlocks, "maxBlocks");
  if (limit < 1 || limit > 100_000) throw new Error("maxBlocks 必须在 1 到 100000 之间");

  const targets = [];
  const materials = new Map();
  for (const regionName of Object.keys(regions).sort()) {
    const region = object(regions[regionName], `Regions.${regionName}`);
    const position = coordinates(region.Position, `Regions.${regionName}.Position`);
    const size = coordinates(region.Size, `Regions.${regionName}.Size`);
    const width = Math.abs(size.x);
    const height = Math.abs(size.y);
    const depth = Math.abs(size.z);
    if (!width || !height || !depth) continue;
    const cellCount = width * height * depth;
    if (!Number.isSafeInteger(cellCount) || cellCount > MAX_REGION_CELLS) throw new Error(`区域 ${regionName} 尺寸超过安全上限 ${MAX_REGION_CELLS} 格`);
    const paletteRaw = Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : [];
    if (!paletteRaw.length) throw new Error(`Regions.${regionName} 缺少 BlockStatePalette`);
    const palette = paletteRaw.map((entry, index) => paletteBlock(entry, index, regionName));
    const words = longWords(region.BlockStates || []);
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    for (let y = 0; y < height; y += 1) {
      for (let z = 0; z < depth; z += 1) {
        for (let x = 0; x < width; x += 1) {
          const paletteEntry = palette[paletteIndex(words, x + z * width + y * width * depth, bits)];
          if (!paletteEntry || paletteEntry.id.endsWith(":air") || paletteEntry.id === "minecraft:cave_air" || paletteEntry.id === "minecraft:void_air") continue;
          if (targets.length >= limit) throw new Error(`蓝图方块数量超过 maxBlocks=${limit}`);
          const local = { x: size.x < 0 ? -x - 1 : x, y: size.y < 0 ? -y - 1 : y, z: size.z < 0 ? -z - 1 : z };
          const regionOrigin = absoluteRegionOrigin(position, size);
          const rotated = rotate(regionOrigin.x + local.x, regionOrigin.z + local.z, turn);
          const target = { x: anchor.x + rotated.x, y: anchor.y + regionOrigin.y + local.y, z: anchor.z + rotated.z };
          targets.push({ ...target, blockId: paletteEntry.id, blockState: paletteEntry.state, region: regionName });
          materials.set(paletteEntry.id, (materials.get(paletteEntry.id) || 0) + 1);
        }
      }
    }
  }
  if (!targets.length) throw new Error("蓝图没有可建造的非空气方块");
  return {
    name: filename,
    file,
    origin: anchor,
    rotation: turn,
    targets,
    blockCount: targets.length,
    materials: Object.fromEntries([...materials.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export async function listLitematicNames({ directory, limit = 200 } = {}) {
  const roots = blueprintDirectories(directory);
  const files = new Set();
  const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.litematic$/iu.test(entry.name)) continue;
      try {
        files.add(safeBlueprintName(entry.name));
      } catch {
        // Ignore files that cannot pass the same backend name policy as builds.
      }
      if (files.size >= max) break;
    }
    if (files.size >= max) break;
  }
  return { directories: roots, files: [...files].sort((a, b) => a.localeCompare(b, "zh-CN")) };
}

export { DEFAULT_BLUEPRINT_DIR, DEFAULT_MAX_BLOCKS, safeBlueprintName, BLUEPRINT_NAME_PATTERN, blueprintDirectories };
