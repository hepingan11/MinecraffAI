import { readFile } from "node:fs/promises";
import process from "node:process";
import { TextDecoder } from "node:util";
import { discoverWindows, getEnvironment, getInventory, getMiningStatus, getObservation, publicWindow, sendChat, startMining, stopMining, validateMessage, validateMiningPlan } from "./minecraft-mod-api.mjs";

const DEFAULT_LOG_PATH = String.raw`G:\Game\[PCL启动器打包]RO26.2性能优化+生电轻量版 1.0.1\.minecraft\versions\[PCL启动器打包]RO26.2性能优化+生电轻量版\logs\latest.log`;
const decoder = new TextDecoder("gb18030");

function fail(message, code = 1) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = code;
}

async function readChat(logPath, count) {
  const bytes = await readFile(logPath);
  const text = decoder.decode(bytes);
  return text.split(/\r?\n/)
    .filter((line) => line.includes("[CHAT]"))
    .slice(-count)
    .map((line) => {
      const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\].*?\[CHAT\]\s*(.*)$/);
      return match ? { time: match[1], text: match[2] } : { text: line };
    });
}

function parseWindowId(args) {
  const index = args.indexOf("--window-id");
  if (index < 0) return { windowId: undefined, args };
  const windowId = args[index + 1];
  if (!windowId) throw new Error("--window-id 缺少窗口标识");
  return { windowId: String(windowId), args: args.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1) };
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const logPath = process.env.MC_LOG_PATH ?? DEFAULT_LOG_PATH;
  if (!command || !["read", "send", "windows", "inventory", "environment", "observe", "mine", "mining-status", "mining-stop"].includes(command)) {
    throw new Error("用法: node minecraft-chat-bridge.mjs read [数量] | windows | inventory | environment | observe | mine | mining-status | mining-stop");
  }

  if (command === "read") {
    const count = Math.min(Math.max(Number.parseInt(rawArgs[0] ?? "20", 10) || 20, 1), 200);
    console.log(JSON.stringify({ ok: true, messages: await readChat(logPath, count) }, null, 2));
    return;
  }

  const windows = await discoverWindows();
  if (command === "windows") {
    console.log(JSON.stringify({ ok: true, windows: windows.map(publicWindow) }, null, 2));
    return;
  }

  if (command === "inventory") {
    const { windowId } = parseWindowId(rawArgs);
    if (windows.length === 0) throw new Error("未检测到已安装 Minecraft AI Mod 的窗口");
    if (windows.length > 1 && !windowId) throw new Error("检测到多个 Minecraft 窗口，请指定 --window-id");
    const selected = windowId ? windows.find((window) => window.id === windowId) : windows[0];
    if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
    console.log(JSON.stringify({ ok: true, skill: "minecraft_inventory", windowId: selected.id, inventory: await getInventory(selected) }, null, 2));
    return;
  }

  if (command === "environment") {
    const { windowId } = parseWindowId(rawArgs);
    if (windows.length === 0) throw new Error("未检测到已安装 Minecraft AI Mod 的窗口");
    if (windows.length > 1 && !windowId) throw new Error("检测到多个 Minecraft 窗口，请指定 --window-id");
    const selected = windowId ? windows.find((window) => window.id === windowId) : windows[0];
    if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
    console.log(JSON.stringify({ ok: true, skill: "minecraft_environment", windowId: selected.id, environment: await getEnvironment(selected) }, null, 2));
    return;
  }

  if (command === "observe") {
    const { windowId } = parseWindowId(rawArgs);
    if (windows.length === 0) throw new Error("未检测到已安装 Minecraft AI Mod 的窗口");
    if (windows.length > 1 && !windowId) throw new Error("检测到多个 Minecraft 窗口，请指定 --window-id");
    const selected = windowId ? windows.find((window) => window.id === windowId) : windows[0];
    if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
    console.log(JSON.stringify({ ok: true, skill: "minecraft_observe", windowId: selected.id, observation: await getObservation(selected) }, null, 2));
    return;
  }

  if (["mine", "mining-status", "mining-stop"].includes(command)) {
    const { windowId, args } = parseWindowId(rawArgs);
    if (windows.length === 0) throw new Error("未检测到已安装 Minecraft AI Mod 的窗口");
    if (windows.length > 1 && !windowId) throw new Error("检测到多个 Minecraft 窗口，请指定 --window-id");
    const selected = windowId ? windows.find((window) => window.id === windowId) : windows[0];
    if (!selected) throw new Error("指定的 Minecraft 窗口不存在或已离线");
    if (command === "mining-status") {
      console.log(JSON.stringify(await getMiningStatus(selected), null, 2));
      return;
    }
    if (command === "mining-stop") {
      console.log(JSON.stringify(await stopMining(selected), null, 2));
      return;
    }
    const plan = validateMiningPlan({
      strategy: args.find((arg) => arg.startsWith("--strategy="))?.slice(11),
      targetBlocks: args.find((arg) => arg.startsWith("--targets="))?.slice(10)?.split(","),
      quantity: args.find((arg) => arg.startsWith("--quantity="))?.slice(11),
      maxMinutes: args.find((arg) => arg.startsWith("--minutes="))?.slice(10),
      maxBlocks: args.find((arg) => arg.startsWith("--max-blocks="))?.slice(13),
    });
    console.log(JSON.stringify({ ok: true, windowId: selected.id, plan, result: await startMining(selected, plan) }, null, 2));
    return;
  }

  if (!rawArgs.includes("--confirm")) throw new Error("发送消息需要显式添加 --confirm");
  const { windowId, args } = parseWindowId(rawArgs);
  const message = validateMessage(args.filter((arg) => arg !== "--confirm").join(" "));
  if (windows.length === 0) throw new Error("未检测到已安装 Minecraft AI Mod 的窗口");
  if (windows.length > 1 && !windowId) throw new Error("检测到多个 Minecraft 窗口，请指定 --window-id");
  const selected = windowId ? windows.find((window) => window.id === windowId) : windows[0];
  if (!selected) throw new Error("所选 Minecraft 窗口已不存在，请重新选择");
  const result = await sendChat(selected, message);
  console.log(JSON.stringify({ ok: true, sent: message, windowId: selected.id, result }));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
