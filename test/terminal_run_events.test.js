const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");
const {
  desktopTerminalTransition,
  desktopTerminalRunSummary,
  desktopTerminalRunEvent,
  desktopTerminalRunReceivers,
  desktopRunFileWatchEvaluate,
  desktopRunFileWatchStart,
  desktopRunFileWatchStop,
} = __test;

const THREAD_ID = "0af83a58-7e21-4c11-9e64-8ff45b6e91a2";

test("terminal dedup keys on rollout evidence: more content is a new run, UI lag never re-arms", () => {
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed", 100), "completed");
  // recorded_terminal 残留：同一证据的重复终态不重发
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed", 100), null);
  // UI 状态滞后（文件已终态、页面还在 running）不得解除武装，也不得重发
  assert.equal(desktopTerminalTransition(THREAD_ID, "running"), null);
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed", 100), null);
  // 追问新一轮：rollout 追加了更多内容 → 新终态
  assert.equal(desktopTerminalTransition(THREAD_ID, "completed", 260), "completed");
  // 状态变化（completed → failed）总是新终态
  assert.equal(desktopTerminalTransition(THREAD_ID, "failed", 300), "failed");
  assert.equal(desktopTerminalTransition(THREAD_ID, "failed", 300), null);
  // 无证据时按时间窗兜底：10s 内同状态不重发
  assert.equal(desktopTerminalTransition(THREAD_ID, "idle"), null);
  assert.equal(desktopTerminalTransition(THREAD_ID, "interrupted", 0), "interrupted");
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

test("rollout file watch decides terminal, timeout, or continue", () => {
  const tracker = { startedAt: 1000 };
  assert.deepEqual(desktopRunFileWatchEvaluate(tracker, { terminal: false }, 2000), { action: "continue" });
  assert.deepEqual(
    desktopRunFileWatchEvaluate(tracker, { terminal: true, failed: false }, 2000),
    { action: "terminal", status: "completed" },
  );
  assert.deepEqual(
    desktopRunFileWatchEvaluate(tracker, { terminal: true, failed: true }, 2000),
    { action: "terminal", status: "failed" },
  );
  // 30 分钟超时清理，不产生事件
  assert.deepEqual(
    desktopRunFileWatchEvaluate(tracker, { terminal: false }, 1000 + 30 * 60 * 1000),
    { action: "timeout" },
  );
});

test("rollout file watch registers once per thread and stops cleanly", () => {
  const fakeFile = "/tmp/definitely-missing-rollout.jsonl";
  desktopRunFileWatchStart(THREAD_ID, fakeFile);
  // 重复注册必须被忽略（一个线程只有一个探测定时器），停止可重复调用
  desktopRunFileWatchStart(THREAD_ID, fakeFile);
  desktopRunFileWatchStop(THREAD_ID);
  desktopRunFileWatchStop(THREAD_ID);
});
