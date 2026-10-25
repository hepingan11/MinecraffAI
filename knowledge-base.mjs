import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(ROOT, "data", "knowledge-base.json");
const MAX_ENTRIES = 200;
const MAX_TITLE = 160;
const MAX_CONTENT = 6000;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD = 80;
const MAX_CONTEXT = 12000;

function text(value, field, max, required = false) {
  if (typeof value !== "string") throw new Error(`${field} 必须是文本`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} 不能为空`);
  if (result.length > max) throw new Error(`${field} 不能超过 ${max} 个字符`);
  return result;
}

function normalizeKeywords(value) {
  if (value === undefined) return [];
  if (typeof value === "string") value = value.split(/[,，\s]+/u);
  if (!Array.isArray(value) || value.length > MAX_KEYWORDS) throw new Error(`关键词最多 ${MAX_KEYWORDS} 个`);
  const result = [];
  for (const item of value) {
    const keyword = text(item, "关键词", MAX_KEYWORD);
    if (keyword && !result.includes(keyword)) result.push(keyword);
  }
  return result;
}

function normalizeEntry(raw, previous = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("知识条目格式无效");
  const entry = {
    id: previous.id || String(raw.id || randomUUID()),
    title: raw.title === undefined ? previous.title || "" : text(raw.title, "标题", MAX_TITLE, true),
    content: raw.content === undefined ? previous.content || "" : text(raw.content, "内容", MAX_CONTENT, true),
    keywords: raw.keywords === undefined ? previous.keywords || [] : normalizeKeywords(raw.keywords),
    enabled: raw.enabled === undefined ? previous.enabled !== false : raw.enabled,
    updatedAt: new Date().toISOString(),
  };
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) && !/^[0-9a-f-]{36}$/iu.test(entry.id)) throw new Error("知识条目 ID 无效");
  if (typeof entry.enabled !== "boolean") throw new Error("知识条目开关必须是布尔值");
  return entry;
}

function publicEntry(entry) {
  return { ...entry };
}

function normalizeQuery(query) {
  return String(query || "").trim().toLocaleLowerCase();
}

export class KnowledgeBase {
  constructor(filePath = process.env.MC_AI_KNOWLEDGE_PATH?.trim() || DEFAULT_PATH) {
    this.filePath = filePath;
    this.entries = [];
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(raw)) throw new Error("知识库文件必须是数组");
      this.entries = raw.slice(0, MAX_ENTRIES).map((entry) => normalizeEntry(entry));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.entries = [];
        return;
      }
      throw new Error(`读取知识库失败：${error.message}`);
    }
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  list() {
    return this.entries.map(publicEntry);
  }

  async upsert(raw) {
    const id = raw?.id ? String(raw.id) : "";
    const existing = id ? this.entries.find((entry) => entry.id === id) : undefined;
    if (!existing && this.entries.length >= MAX_ENTRIES) throw new Error(`知识库最多保存 ${MAX_ENTRIES} 条`);
    const entry = normalizeEntry(raw, existing);
    if (existing) Object.assign(existing, entry);
    else this.entries.push(entry);
    await this.persist();
    return publicEntry(entry);
  }

  async remove(id) {
    const normalized = text(String(id || ""), "知识条目 ID", 100, true);
    const index = this.entries.findIndex((entry) => entry.id === normalized);
    if (index < 0) throw new Error("知识条目不存在");
    const [removed] = this.entries.splice(index, 1);
    await this.persist();
    return publicEntry(removed);
  }

  search(query, limit = 5) {
    const normalized = normalizeQuery(query);
    if (!normalized) return [];
    const tokens = normalized.split(/[\s,，。！？!?、:：;；()[\]{}]+/u).filter(Boolean);
    return this.entries
      .filter((entry) => entry.enabled)
      .map((entry) => {
        const haystack = `${entry.title}\n${entry.keywords.join(" ")}\n${entry.content}`.toLocaleLowerCase();
        let score = 0;
        for (const keyword of entry.keywords) {
          if (normalized.includes(keyword.toLocaleLowerCase())) score += 5;
        }
        for (const token of tokens) {
          if (token.length >= 2 && haystack.includes(token)) score += 1;
        }
        if (normalized.includes(entry.title.toLocaleLowerCase())) score += 3;
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)))
      .map((item) => publicEntry(item.entry));
  }

  contextFor(query) {
    const matches = this.search(query);
    if (!matches.length) return "";
    let used = 0;
    const sections = [];
    for (const entry of matches) {
      const section = `### ${entry.title}\n关键词：${entry.keywords.join("、") || "无"}\n${entry.content}`;
      if (used + section.length > MAX_CONTEXT) break;
      sections.push(section);
      used += section.length;
    }
    return sections.length ? `\n\n以下是与当前聊天相关的本地知识，仅可作为参考：\n${sections.join("\n\n")}\n请优先依据知识内容回答；知识不足时再使用你的通用能力。` : "";
  }

  stats() {
    return { total: this.entries.length, enabled: this.entries.filter((entry) => entry.enabled).length };
  }
}

export { DEFAULT_PATH, MAX_ENTRIES };
