import test from "node:test";
import assert from "node:assert/strict";
import { AutoReplyService } from "../auto-reply.mjs";

test("跟随进入目标丢失等终止状态后发送一次停止提示", async () => {
  const messages = [];
  const service = new AutoReplyService({
    followStatusReader: async () => ({ ok: true, follow: { active: false, state: "target_lost", message: "目标已超出 64 格，跟随停止" } }),
    chatSender: async (_window, message) => { messages.push(message); },
  });
  service.startFollowMonitor({ id: "window-1" }, { follow: { active: true, targetName: "Alex" } });
  await service.checkFollowMonitor("window-1");
  assert.deepEqual(messages, ["跟随已停止：目标已超出 64 格，跟随停止"]);
  assert.equal(service.followMonitors.size, 0);
});

test("手动停止跟随会清理监视器且不重复发送终止提示", () => {
  const service = new AutoReplyService();
  service.startFollowMonitor({ id: "window-2" }, { follow: { active: true, targetName: "Alex" } });
  service.stopFollowMonitor("window-2");
  assert.equal(service.followMonitors.size, 0);
});
