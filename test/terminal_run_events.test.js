const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");
const { desktopTerminalTransition, desktopTerminalRunSummary, desktopTerminalRunEvent, desktopTerminalRunReceivers } = __test;

const THREAD_ID = "0af83a58-7e21-4c11-9e64-8ff45b6e91a2";

test("terminal run events emit once per transition and re-arm on non-terminal state", () => {
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed"), "completed");
  // recorded_terminal 残留：完成后改设置/切前台仍是 completed，不得重发
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed"), null);
  // 新一轮运行使状态离开终态，重新武装
  assert.equal(desktopTerminalTransition(THREAD_ID, "running"), null);
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed"), "completed");
  assert.equal(desktopTerminalTransition(THREAD_ID, "failed"), "failed");
  assert.equal(desktopTerminalTransition(THREAD_ID, "failed"), null);
  assert.equal(desktopTerminalTransition(THREAD_ID, "idle"), null);
  assert.equal(desktopTerminalTransition(THREAD_ID, ""), null);
});

test("terminal run summary prefers rollout text for completed and error text for failed", () => {
  assert.equal(desktopTerminalRunSummary("completed", "Codex 已完成。", "最终回答正文"), "最终回答正文");
  assert.equal(desktopTerminalRunSummary("completed", "", ""), "Codex 已完成。");
  assert.equal(desktopTerminalRunSummary("failed", "执行出错：超时", ""), "执行出错：超时");
  assert.equal(desktopTerminalRunSummary("failed", "", ""), "Codex 执行失败。");
  assert.equal(desktopTerminalRunSummary("interrupted", "", ""), "Codex 任务已被打断。");
});

test("terminal run event carries routing payload for the hub conversation forward", () => {
  const hint = { plugin_id: "codex", native_thread_id: THREAD_ID, cwd: "/tmp/proj" };
  const event = desktopTerminalRunEvent(THREAD_ID, "failed", "执行出错：超时", hint, { run: { status: "failed" } });

  assert.equal(event.Type, "run.failed");
  assert.equal(event.Status, "failed");
  assert.equal(event.Summary, "执行出错：超时");
  assert.equal(event.Payload.thread_id, THREAD_ID);
  assert.equal(event.Payload.native_session.native_thread_id, THREAD_ID);
  assert.equal(event.Payload.native_session.surface, "codex-desktop");
  assert.equal(event.Payload.session_hint.cwd, "/tmp/proj");
  assert.deepEqual(event.Payload.detail_snapshot, { run: { status: "failed" } });
  assert.match(event.ID, /^desktop-run-/);
});

test("terminal run events reach plugin-wide watchers and matching threads only", () => {
  const subscribers = [
    { name: "hub-plugin-wide", pluginWide: true },
    { name: "matching-thread", threadID: THREAD_ID },
    { name: "other-thread", threadID: "11111111-2222-4333-8444-555555555555" },
  ];
  const receivers = desktopTerminalRunReceivers(THREAD_ID, subscribers);
  assert.deepEqual(
    receivers.map((subscriber) => subscriber.name),
    ["hub-plugin-wide", "matching-thread"],
  );
});
