import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { followCommandFromChat, executeFollowCommand, selectFollowCandidates, parseMinecraftChat, followReplyFromResult } from "../follow-skill.mjs";
import { validateFollowPlan, getFollowStatus, getObservation } from "../minecraft-mod-api.mjs";
import { AutoReplyService } from "../auto-reply.mjs";

const alex = { uuid: "00000000-0000-0000-0000-000000000001", name: "Alex", distance: 12 };
const steve = { uuid: "00000000-0000-0000-0000-000000000002", name: "Steve", distance: 5 };

test("follow commands use only imperative current messages and resolve the speaker", () => {
  for (const text of ["跟随", "请开始跟随附近的玩家", "follow", "follow nearest"]) assert.deepEqual(followCommandFromChat(text), { action: "start" });
  assert.deepEqual(followCommandFromChat("<Alex> @MinecraftAI 跟随我"), { action: "start", targetName: "Alex" });
  assert.deepEqual(followCommandFromChat("<Alex> @MinecraftAI 跟着 Steve！"), { action: "start", targetName: "Steve" });
  for (const text of ["停止跟随", "不要跟随我", "stop following", "请取消跟随"]) assert.deepEqual(followCommandFromChat(text), { action: "stop" });
  for (const text of ["你在跟随谁", "怎么跟随玩家", "怎么停止跟随", "可以跟随我吗", "你正在跟随Steve", "不要开始跟随", "<跟随> @MinecraftAI 你好", "can you follow me?", "跟随任务进展如何"]) assert.equal(followCommandFromChat(text), null, text);
});

test("real server public/private chat formats identify the sender, not the recipient", () => {
  for (const text of [
    "[He_ping_an head]九华阁 He_ping_an: @Guiwuli77 跟随我",
    "[[He_ping_an head]He_ping_an -> me] @Guiwuli77 跟随我",
    "[He_ping_an -> me] @Guiwuli77 跟随我",
  ]) assert.deepEqual(followCommandFromChat(text), { action: "start", targetName: "He_ping_an" }, text);
  const outgoing = "[me -> [Guiwuli77 head]Guiwuli77] @Guiwuli77 跟随我";
  assert.equal(parseMinecraftChat(outgoing).outgoing, true);
  assert.equal(parseMinecraftChat(outgoing).recipient, "Guiwuli77");
  assert.deepEqual(followCommandFromChat(outgoing), { action: "start", unresolvedSender: true });
  assert.deepEqual(followCommandFromChat("[[He_ping_an head]He_ping_an -> me] @Guiwuli77 停止跟随"), { action: "stop" });
  assert.equal(followCommandFromChat("[He_ping_an head]九华阁 He_ping_an: @Guiwuli77 你在跟随谁"), null);
});

test("follow replies are determined by actual execution and never assert movement for failed/paused tasks", () => {
  const command = { action: "start" };
  for (const result of [undefined, { ok: false, executionError: "附近无人" }, { ok: true, follow: { active: false, state: "safety_stop", message: "前方有岩浆" } }]) {
    assert.doesNotMatch(followReplyFromResult(result, command), /正在执行跟随/u);
  }
  assert.match(followReplyFromResult({ ok: true, follow: { active: true, state: "paused", targetName: "Alex" } }, command), /暂未移动/u);
  assert.match(followReplyFromResult({ ok: true, follow: { active: true, state: "holding", targetName: "Alex" } }, command), /保持距离/u);
  assert.match(followReplyFromResult({ ok: true, follow: { active: true, state: "pathfinding", targetName: "Alex" } }, command), /暂未移动/u);
});

test("selection chooses nearest, breaks ties by UUID and respects explicit names/UUIDs", () => {
  assert.equal(selectFollowCandidates([alex, steve])[0].uuid, steve.uuid);
  assert.equal(selectFollowCandidates([steve, { ...alex, distance: 5 }])[0].uuid, alex.uuid);
  assert.equal(selectFollowCandidates([alex, steve], { targetName: "aLeX" })[0].uuid, alex.uuid);
  assert.equal(selectFollowCandidates([alex, steve], { targetUuid: steve.uuid })[0].uuid, steve.uuid);
  assert.deepEqual(selectFollowCandidates([{ ...alex, distance: 33 }, { ...steve, distance: NaN }, { ...alex, distance: -1 }]), []);
});

test("backend rejects invalid plans before invoking the Mod", () => {
  for (const plan of [null, [], { followDistance: null }, { maxMinutes: null }, { ignoreSafety: null }, { ignoreSafety: "true" }, { followDistance: 1 }, { followDistance: 7 }, { followDistance: "3" }, { followDistance: NaN }, { maxMinutes: 0 }, { maxMinutes: 31 }, { targetUuid: "fake" }, { targetName: "../Steve" }, { targetName: 42 }]) assert.throws(() => validateFollowPlan(plan));
  assert.deepEqual(validateFollowPlan({}), { followDistance: 3, maxMinutes: 10 });
  assert.equal(validateFollowPlan({ ignoreSafety: true }).ignoreSafety, true);
  assert.equal(validateFollowPlan({ ignoreSafety: false }).ignoreSafety, false);
});

test("authenticated discovery → selection → start, dashboard/CLI, stop and failure handling", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "minecraft-follow-test-"));
  const oldRegistry = process.env.MC_AI_REGISTRY_DIR;
  process.env.MC_AI_REGISTRY_DIR = temporary;
  let players = [alex, steve];
  let task = null;
  let failStart = false;
  let failState = false;
  const requests = [];
  const mod = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer test-token") { res.writeHead(401); res.end('{"ok":false}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ path: req.url, body });
    if (req.url === "/state" && failState) { res.writeHead(500); res.end('{"ok":false,"error":"state unavailable"}'); return; }
    let value = { ok: true };
    if (req.url === "/health") value.connected = true;
    if (req.url === "/players") value.players = players;
    if (req.url === "/follow/start") {
      const chosen = players.find((p) => p.uuid === body.targetUuid);
      if (failStart || !chosen || task?.active) {
        res.writeHead(409); res.end(JSON.stringify({ ok: false, error: failStart ? "目标已离开范围" : "已有跟随任务" })); return;
      }
      task = { state: "following", active: true, targetUuid: chosen.uuid, targetName: chosen.name };
    }
    if (req.url === "/follow/stop" && task) task = { ...task, active: false, state: "stopped" };
    if (req.url.startsWith("/follow/")) value = { ok: true, status: task?.state ?? "idle", ...(task ? { follow: task } : {}) };
    if (req.url === "/state") value.activity = task?.active ? "following" : "idle";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  mod.listen(0, "127.0.0.1");
  await once(mod, "listening");
  const window = { id: "123", host: "127.0.0.1", port: mod.address().port, token: "test-token" };
  await writeFile(path.join(temporary, "123.json"), JSON.stringify(window), "utf8");
  let dashboard;
  t.after(async () => {
    if (dashboard && dashboard.exitCode === null) { dashboard.kill(); await once(dashboard, "exit"); }
    await new Promise((resolve) => mod.close(resolve));
    if (oldRegistry === undefined) delete process.env.MC_AI_REGISTRY_DIR; else process.env.MC_AI_REGISTRY_DIR = oldRegistry;
    await rm(temporary, { recursive: true, force: true });
  });

  const started = await executeFollowCommand(window, { action: "start" });
  assert.deepEqual(requests.map((request) => request.path), ["/players", "/follow/start", "/follow/status"]);
  assert.equal(started.follow.targetName, "Steve");
  assert.equal(started.selection.candidates.length, 2);
  assert.equal((await getObservation(window)).follow.follow.targetUuid, steve.uuid);
  failState = true;
  assert.equal((await getObservation(window)).activity, "following");
  failState = false;
  await assert.rejects(executeFollowCommand(window, { action: "start" }), /已有跟随任务/u);
  assert.equal((await executeFollowCommand(window, { action: "stop" })).status, "stopped");
  assert.equal((await executeFollowCommand(window, { action: "start", targetName: "Alex" })).follow.targetUuid, alex.uuid);
  await executeFollowCommand(window, { action: "stop" });
  players = [];
  const count = requests.length;
  await assert.rejects(executeFollowCommand(window, { action: "start" }), /没有可跟随/u);
  assert.equal(requests.length, count + 1);
  await assert.rejects(executeFollowCommand(window, { action: "start", unresolvedSender: true }), /无法从聊天日志确认/u);
  assert.equal(requests.length, count + 1);
  players = [alex, steve];
  failStart = true;
  await assert.rejects(executeFollowCommand(window, { action: "start" }), /目标已离开/u);
  failStart = false;

  const service = new AutoReplyService({ skillExecutor: async (skill) => {
    if (skill === "minecraft_follow") throw new Error("目标已离线");
    return { activity: "idle" };
  } });
  const context = await service.skillContextFor("<Alex> @MinecraftAI 跟随我");
  assert.match(context, /executionError/u);
  assert.deepEqual(service.status.lastSkills, ["minecraft_follow", "minecraft_observe"]);
  await service.skillContextFor("<Alex> @MinecraftAI 你在跟随谁");
  assert.deepEqual(service.status.lastSkills, ["minecraft_observe"]);
  assert.match(await service.generateReply("[[Alex head]Alex -> me] @MinecraftAI 跟随我"), /目标已离线/u);
  // No API key is configured, so a model request would fail this regression test.
  const feedbackService = new AutoReplyService({ skillExecutor: async (skill) => skill === "minecraft_follow"
    ? { ok: true, follow: { active: true, state: "paused", targetName: "Alex" } } : { activity: "following" } });
  assert.match(await feedbackService.generateReply("[Alex head]九华阁 Alex: @MinecraftAI 跟随我"), /暂未移动/u);
  let generated = 0;
  feedbackService.generateReply = async () => { generated++; return "已停止跟随。"; };
  await feedbackService.processLine("[21:54:38] [Render thread/INFO]: [CHAT] [me -> [Alex head]Alex] @MinecraftAI 跟随我");
  assert.equal(generated, 0, "outgoing echo must not trigger another command");
  await feedbackService.processLine("[21:54:38] [Render thread/INFO]: [CHAT] [[Alex head]Alex -> me] @MinecraftAI 跟随我");
  assert.equal(generated, 1, "incoming private chat must trigger");
  const miningFailure = new AutoReplyService({ skillExecutor: async (skill) => {
    if (skill === "minecraft_mining") throw new Error("背包中没有可用的镐");
    return { activity: "idle" };
  } });
  assert.match(await miningFailure.skillContextFor("<Alex> @MinecraftAI 开始挖矿"), /executionError/u);
  assert.deepEqual(miningFailure.status.lastSkills, ["minecraft_mining", "minecraft_observe"]);

  const portProbe = http.createServer();
  portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  dashboard = spawn(process.execPath, ["minecraft-dashboard.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, MC_DASHBOARD_PORT: String(port), MC_AI_CONFIG_PATH: path.join(temporary, "config.json"), MC_AI_TASKS_PATH: path.join(temporary, "tasks.json"), MC_AI_KNOWLEDGE_PATH: path.join(temporary, "knowledge.json"), MC_AI_EXPERIENCE_PATH: path.join(temporary, "experiences.json") },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(dashboard.stdout, "data"),
    once(dashboard, "exit").then(() => { throw new Error("Dashboard exited before listening"); }),
    new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error("Dashboard startup timed out")), 5000); timeout.unref(); }),
  ]);
  const api = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`http://127.0.0.1:${port}/api/skills/${route}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await api("minecraft_players")).data.result.players.length, 2);
  assert.equal((await api("minecraft_follow", { targetName: "Alex" })).data.result.follow.targetName, "Alex");
  assert.equal((await api("minecraft_follow")).data.result.status, "following");
  assert.equal((await api("minecraft_follow/stop", {})).data.result.status, "stopped");
  assert.equal((await api("minecraft_follow/stop")).status, 405);
  assert.equal((await api("minecraft_follow", { followDistance: -1 })).status, 400);
  assert.equal((await api("minecraft_follow", null)).status, 400);
  assert.equal((await api("minecraft_follow", { windowId: "offline" })).status, 400);
  await writeFile(path.join(temporary, "456.json"), JSON.stringify({ ...window, id: "456" }), "utf8");
  assert.match((await api("minecraft_follow", {})).data.error, /多个/u);
  assert.equal((await api("minecraft_follow", { windowId: "123" })).data.result.follow.targetName, "Steve");
  await api("minecraft_follow/stop", { windowId: "123" });
  const cli = spawn(process.execPath, ["minecraft-chat-bridge.mjs", "follow", "--window-id", "123", "--player=Alex"], { cwd: path.resolve(import.meta.dirname, ".."), env: process.env, windowsHide: true });
  let output = "";
  cli.stdout.setEncoding("utf8").on("data", (text) => { output += text; });
  const [exitCode] = await once(cli, "exit");
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output).result.follow.targetName, "Alex");
  await executeFollowCommand(window, { action: "stop" });
  assert.equal((await getFollowStatus(window)).follow.active, false);
});
