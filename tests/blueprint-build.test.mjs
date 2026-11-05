import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nbt from "prismarine-nbt";
import { TaskStateStore } from "../src/core/task-state.mjs";
import { runBlueprintBuild } from "../src/skills/minecraft-build-tools.mjs";

function response(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

test("blueprint build performs inventory preflight, inspect, move, support-aware place and task completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraffai-build-"));
  const tasks = new TaskStateStore(path.join(directory, "tasks.json"));
  const root = nbt.comp({
    Version: nbt.int(6),
    Regions: nbt.comp({ house: nbt.comp({
      Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }),
      Size: nbt.comp({ x: nbt.int(1), y: nbt.int(1), z: nbt.int(1) }),
      BlockStatePalette: nbt.list(nbt.comp([{ Name: nbt.string("minecraft:stone") }])) ,
      BlockStates: nbt.longArray([0n]),
    }) }),
  });
  await writeFile(path.join(directory, "one.litematic"), nbt.writeUncompressed(root));
  const placed = new Set();
  let blueprintRequest;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { response(res, { ok: false, error: "bad json" }, 400); return; }
      if (req.url === "/inventory") return response(res, { ok: true, items: [{ itemId: "minecraft:stone", count: 4 }] });
      if (req.url === "/environment") return response(res, { ok: true, position: { x: 0, y: 64, z: 0 } });
      if (req.url === "/blueprint/start") {
        blueprintRequest = body;
        return response(res, { ok: true, blueprint: { id: "blueprint-1", active: true, state: "running", total: 1, completed: 0, remaining: 1 } });
      }
      if (req.url === "/blueprint/status") return response(res, { ok: true, blueprint: { id: "blueprint-1", active: false, state: "completed", total: 1, completed: 1, remaining: 0 } });
      if (req.url === "/blocks/inspect") {
        return response(res, { ok: true, blocks: body.positions.map((position) => ({
          position,
          loaded: true,
          blockId: placed.has(`${position.x},${position.y},${position.z}`) ? "minecraft:stone" : (position.y === 63 ? "minecraft:dirt" : "minecraft:air"),
          air: position.y !== 63 && !placed.has(`${position.x},${position.y},${position.z}`),
          replaceable: position.y !== 63 && !placed.has(`${position.x},${position.y},${position.z}`),
        })) });
      }
      if (req.url === "/move/start") return response(res, { ok: true, move: { id: "move-1", active: false, state: "completed" } });
      if (req.url === "/blocks/place") { placed.add(`${body.x},${body.y},${body.z}`); return response(res, { ok: true, action: { id: "place-1", active: false, state: "completed", changed: true } }); }
      response(res, { ok: false, error: `unexpected ${req.url}` }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousDirectory = process.env.MC_AI_BLUEPRINT_DIR;
  process.env.MC_AI_BLUEPRINT_DIR = directory;
  try {
    const result = await runBlueprintBuild(
      { id: "test-window", host: "127.0.0.1", port: server.address().port, token: "test-token" },
      { name: "one.litematic", origin: { x: 0, y: 64, z: 0 }, rotation: 0, dimension: "minecraft:overworld" },
      { taskState: tasks },
    );
    assert.equal(result.ok, true);
    assert.equal(result.placed, 1);
    assert.equal(blueprintRequest.targets.length, 1);
    assert.equal(blueprintRequest.targets[0].blockState, "minecraft:stone");
    assert.equal(tasks.list({ kind: "blueprint_build" })[0].status, "succeeded");
  } finally {
    if (previousDirectory === undefined) delete process.env.MC_AI_BLUEPRINT_DIR;
    else process.env.MC_AI_BLUEPRINT_DIR = previousDirectory;
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
