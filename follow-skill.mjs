import { getNearbyPlayers, getFollowStatus, startFollowing, stopFollowing, validateFollowPlan } from "./minecraft-mod-api.mjs";

// Server chat contains player-head components and nested private-message brackets.
export function parseMinecraftChat(chatText) {
  const chat = String(chatText ?? "").trim();
  const standard = chat.match(/^<([^<>\r\n]{1,64})>\s*(.*)$/u);
  if (standard) return { speaker: standard[1], text: standard[2], outgoing: false };
  if (chat.startsWith("[")) {
    let depth = 0;
    for (let index = 0; index < chat.length; index++) {
      if (chat[index] === "[") depth++;
      if (chat[index] === "]") depth--;
      if (depth !== 0) continue;
      const prefix = chat.slice(1, index);
      const arrow = prefix.match(/^(.*?)\s*(?:->|→)\s*(.+)$/u);
      if (arrow) {
        const sender = arrow[1].trim();
        const recipientRaw = arrow[2].trim();
        const outgoing = /^(?:me|我)$/iu.test(sender);
        const name = sender.match(/^\[([\p{L}\p{N}_.-]{1,64}) head\]/u)?.[1]
          || (/^[\p{L}\p{N}_.-]{1,64}$/u.test(sender) ? sender : null);
        const recipient = recipientRaw.match(/^\[([\p{L}\p{N}_.-]{1,64}) head\]/u)?.[1]
          || (/^[\p{L}\p{N}_.-]{1,64}$/u.test(recipientRaw) ? recipientRaw : null);
        return { speaker: outgoing ? null : name, recipient, text: chat.slice(index + 1).trim(), outgoing };
      }
      break;
    }
  }
  const decorated = chat.match(/^\[([\p{L}\p{N}_.-]{1,64}) head\][^:\r\n]{0,160}:\s*(.*)$/u);
  if (decorated) return { speaker: decorated[1], text: decorated[2], outgoing: false };
  return { speaker: null, text: chat, outgoing: false };
}

// Only the current message is parsed; player names in the chat prefix are never commands.
export function followCommandFromChat(chatText) {
  const { speaker, text: content } = parseMinecraftChat(chatText);
  const text = content.replace(/@[\p{L}\p{N}_.-]+/gu, " ").trim().replace(/^[，,:：\s]+|[。！!\s]+$/gu, "");
  if (/(?:怎么|如何|能不能|能否|会不会|是否|可以吗|吗|[?？])|\b(?:can|could|how)\b/iu.test(text)) return null;
  if (/^(?:(?:请|麻烦|你|现在|马上)\s*)*(?:(?:停止|取消|结束|别再|不要|不用|别)\s*(?:再)?\s*(?:跟随|跟着|跟上)|(?:stop|cancel)\s+follow(?:ing)?\b)/iu.test(text)) return { action: "stop" };
  if (/(?:不要|别|不用)|\b(?:don't|do not)\b/iu.test(text)) return null;
  const command = text.match(/^(?:(?:请|麻烦|帮我|你|现在|马上|开始|继续|去|自动|先)\s*)*(?:(?:跟随|跟着|跟上)\s*(?:玩家\s*)?([\p{L}\p{N}_.-]+)?|follow(?:\s+([a-z0-9_.-]+))?\b)/iu);
  if (!command) return null;
  const name = command[1] || command[2];
  if (name === "我" || /^me$/iu.test(name ?? "")) {
    // A sender can be resolved only by an exact match against the live player list.
    return speaker ? { action: "start", targetName: speaker } : { action: "start", unresolvedSender: true };
  }
  const auto = !name || /^(?:人物|玩家|附近|周围|一个人|一位玩家|附近的一位玩家|附近的玩家|周围的玩家|附近玩家|周围玩家|nearest|someone)$/iu.test(name);
  return { action: "start", ...(auto ? {} : { targetName: name }) };
}

export async function executeFollowCommand(window, command) {
  if (command.action === "stop") return stopFollowing(window);
  if (command.unresolvedSender) throw new Error("无法从聊天日志确认“我”是哪位玩家，请使用“跟随 玩家名”或在游戏中向机器人发送私聊");
  const plan = validateFollowPlan(command);
  const nearby = await getNearbyPlayers(window);
  const candidates = selectFollowCandidates(nearby.players, plan);
  const chosen = candidates[0];
  if (!chosen) throw new Error(plan.targetName || plan.targetUuid ? "指定玩家不在 32 格内，无法开始跟随" : "32 格内没有可跟随的其他玩家");
  const started = await startFollowing(window, { ...plan, targetUuid: chosen.uuid });
  // Report the task after its movement loop has run, including immediate safety stops.
  let result = started;
  if (started.follow?.active) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await getFollowStatus(window);
  }
  return {
    ...result,
    ...(result.follow?.active === false ? { executionError: result.follow.message || result.follow.state } : {}),
    selection: { rule: plan.targetName || plan.targetUuid ? "specified_player" : "nearest_player", candidates: nearby.players, chosen },
  };
}

export function followReplyFromResult(result, command) {
  if (result?.executionError || result?.ok !== true) return `跟随指令未成功执行：${result?.executionError || result?.error || "未收到有效的执行结果"}`;
  const task = result?.follow;
  if (command.action === "stop") return task?.active ? "停止跟随尚未确认，请查询当前任务状态。" : "已停止跟随。";
  if (!task || task.active !== true) return `未开始或已停止跟随：${task?.message || task?.state || "Mod 未返回有效的跟随任务"}`;
  const name = task.targetName;
  if (!name) return "无法确认跟随目标，请查询当前任务状态。";
  if (task.state === "paused") return `已锁定 ${name}，但机器人界面打开或游戏暂停，暂未移动；请关闭机器人窗口内的界面并恢复游戏。`;
  if (task.state === "holding") return `已锁定 ${name}，目前已在保持距离范围内；你走远后我会继续靠近。`;
  if (task.state === "pathfinding") return `已锁定 ${name}，正在寻找可通行的绕行路线，暂未移动。`;
  if (task.state === "following") return `已选择 ${name}，正在执行跟随。`;
  return `跟随状态：${task.message || task.state}`;
}

export function selectFollowCandidates(players, plan = {}) {
  if (!Array.isArray(players)) throw new Error("Mod API 返回了无效玩家列表，请更新 Mod");
  return players.filter((player) => player && typeof player.uuid === "string" && typeof player.name === "string"
    && Number.isFinite(player.distance) && player.distance >= 0 && player.distance <= 32
    && (!plan.targetUuid || player.uuid.toLowerCase() === plan.targetUuid)
    && (!plan.targetName || player.name.toLowerCase() === plan.targetName.toLowerCase()))
    .sort((a, b) => a.distance - b.distance || a.uuid.localeCompare(b.uuid));
}
