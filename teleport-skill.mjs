import { parseMinecraftChat } from "./follow-skill.mjs";
import { sendChat } from "./minecraft-mod-api.mjs";

const PLAYER_ID_PATTERN = /^[\p{L}\p{N}_.-]{1,64}$/u;

function cleanContent(value, triggerName = "") {
  let text = String(value ?? "");
  if (triggerName) {
    const escaped = String(triggerName).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    text = text.replace(new RegExp(`@${escaped}(?![\p{L}\p{N}_])`, "iu"), " ");
  }
  return text.trim().replace(/^[，,:：\s]+|[。！!\s]+$/gu, "");
}

export function validateTeleportPlan(plan = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("传送参数格式无效");
  const targetName = String(plan.targetName ?? "").trim();
  if (!PLAYER_ID_PATTERN.test(targetName)) throw new Error("传送目标玩家 ID 无效");
  return { targetName };
}

export function teleportCommandFromChat(chatText, triggerName = "MinecraftAI") {
  const { speaker, text: content } = parseMinecraftChat(chatText);
  const text = cleanContent(content, triggerName);
  if (!text || !speaker) {
    if (!speaker && /(?:传送|teleport|\btp\b)/iu.test(text)) return { action: "request", unresolvedSender: true };
    return null;
  }
  if (/(?:怎么|如何|能不能|能否|会不会|是否|可以吗|吗|[?？])|\b(?:can|could|how)\b/iu.test(text)) return null;
  if (/(?:不要|别|不用|取消|停止)|\b(?:don't|do not|stop|cancel)\b/iu.test(text)) return null;
  const request = /^(?:(?:请|麻烦|帮我|你|现在|马上|快|赶紧|让你)\s*)*(?:(?:(?:传送|teleport|tp)\s*(?:到)?\s*(?:我这里|我这儿|我这|这里|这边)\s*(?:来|过来)?|(?:传送|teleport|tp)\s*(?:过来|过来吧)))[。！!，,\s]*$/iu.test(text);
  if (!request) return null;
  return { action: "request", targetName: speaker };
}

export async function executeTeleportCommand(window, command) {
  if (command?.unresolvedSender) throw new Error("无法从聊天日志确认“我”是哪位玩家，请在游戏聊天中发送传送请求");
  const plan = validateTeleportPlan(command);
  const commandText = `/tpa ${plan.targetName}`;
  const result = await sendChat(window, commandText);
  return { ok: true, action: "request", targetName: plan.targetName, command: commandText, result };
}

export function teleportReplyFromResult(result) {
  if (result?.executionError || result?.ok !== true) return `传送请求未成功执行：${result?.executionError || result?.error || "未收到有效的执行结果"}`;
  if (!result.targetName) return "无法确认传送目标玩家。";
  return `已发送传送请求，请求传送到 ${result.targetName}。`;
}

export { PLAYER_ID_PATTERN };
