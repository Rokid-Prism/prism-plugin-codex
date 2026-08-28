"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { __test } = require("./index");

function row(timestamp, payload, type = "response_item") {
  return JSON.stringify({ timestamp, type, payload });
}

function message(id, role, text, phase = "final_answer") {
  return { type: "message", id, role, phase, content: [{ type: role === "user" ? "input_text" : "output_text", text }] };
}

function legacyImageMessage() {
  return {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "## My request for Codex:\n请检查图片\n<image name=[Image #1] path=\"/private/tmp/codex-clipboard-example.png\">" },
      { type: "input_image", image_url: "data:image/png;base64,secret" },
      { type: "input_text", text: "</image>" },
    ],
  };
}

function withRollout(lines, verify) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-history-stream-"));
  const file = path.join(directory, "rollout.jsonl");
  try {
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    verify(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

withRollout([
  row("2026-07-28T01:00:00.000Z", { type: "task_started", turn_id: "turn-1" }, "event_msg"),
  row("2026-07-28T01:00:01.000Z", { ...message("user-1", "user", "请检查正文同步"), turn_id: "turn-1" }),
  row("2026-07-28T01:00:02.000Z", { ...message("assistant-commentary", "assistant", "正在检查 rollout", "commentary"), turn_id: "turn-1" }),
  row("2026-07-28T01:00:03.000Z", { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"tail -n 20 rollout.jsonl\"}" }),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-1", 20);
  assert.equal(turn.messages[0].Role, "user");
  assert.equal(turn.messages.length, 2);
  const progress = turn.messages[1];
  assert.equal(progress.Type, "progress");
  assert.equal(progress.Status, "running");
  assert.equal(progress.Content, "正在检查 rollout");
  assert.deepEqual(progress.Progress.Steps.map((step) => step.Kind), ["assistant_text", "tool"]);
});

withRollout([
  row("2026-08-05T06:40:00.000Z", { type: "task_started", turn_id: "turn-tool-detail" }, "event_msg"),
  row("2026-08-05T06:40:01.000Z", { ...message("tool-detail-user", "user", "检查执行过程"), turn_id: "turn-tool-detail" }),
  row("2026-08-05T06:40:02.000Z", {
    type: "custom_tool_call",
    call_id: "call-private-input",
    name: "exec",
    input: "const summary = `Current Task internal continuation`; const r = await tools.exec_command({\"cmd\":\"rg -n queue plugins/codex/index.js\"});",
  }),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-tool-detail", 20);
  const step = turn.messages[1].Progress.Steps.find((item) => item.Kind === "tool");
  assert.equal(step.Detail, "rg plugins/codex/index.js");
  assert.doesNotMatch(JSON.stringify(step), /Current Task|continuation/);
});

withRollout([
  row("2026-08-05T06:20:00.000Z", message("visible-user", "user", "保留真实回复")),
  row("2026-08-05T06:20:01.000Z", message("internal-summary", "assistant", "## 当前进度\n- 这是 Codex 的内部续接摘要")),
  row("2026-08-05T06:20:02.000Z", {
    type: "compacted",
    message: "Another language model started to solve this problem and produced a summary of its thinking process.",
    replacement_history: [],
  }, "compacted"),
], (file) => {
  const turns = __test.historyTurnsFromTail(file, "thread-compaction-summary", 20);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messages[0].Content, "保留真实回复");
  assert.doesNotMatch(JSON.stringify(turns), /内部续接摘要/);
});

withRollout([
  row("2026-08-05T06:30:00.000Z", message("visible-user", "user", "保留完成回复")),
  row("2026-08-05T06:30:01.000Z", message("visible-final", "assistant", "这是正常完成回复")),
  row("2026-08-05T06:30:02.000Z", { type: "compacted", message: "ordinary compaction" }, "compacted"),
], (file) => {
  const turns = __test.historyTurnsFromTail(file, "thread-normal-compaction", 20);
  assert.equal(turns.length, 1);
  assert.match(JSON.stringify(turns), /正常完成回复/);
});

withRollout([
  row("2026-07-28T01:00:00.000Z", legacyImageMessage()),
], (file) => {
  const first = __test.historyTurnsFromTail(file, "thread-legacy-image", 20);
  const second = __test.historyTurnsFromTail(file, "thread-legacy-image", 20);
  assert.equal(first.length, 1);
  assert.equal(first[0].turn_id, second[0].turn_id);
  assert.match(first[0].turn_id, /^legacy-message-/);
  const user = first[0].messages[0];
  assert.equal(user.Content, "请检查图片");
  assert.deepEqual(user.Metadata.attachments, [{ name: "codex-clipboard-example.png", kind: "image" }]);
  assert.doesNotMatch(JSON.stringify(user.Metadata.attachments), /data:|base64|\/private\//i);
});

withRollout([
  row("2026-08-13T01:00:00.000Z", {
    type: "message",
    id: "ambient-context-user",
    role: "user",
    content: [{
      type: "input_text",
      text: `<in-app-browser-context source="ambient-ui-state">This block is automatically supplied ambient UI state.\nCurrent URL: http://localhost:5175/panel</in-app-browser-context>\n\n## My request:\n需要重新编译安装Hub吗?`,
    }],
  }),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-ambient-context", 20);
  const user = turn.messages[0];
  assert.equal(user.Content, "需要重新编译安装Hub吗?");
  assert.doesNotMatch(user.Content, /ambient-ui-state|Current URL|in-app-browser-context/i);
  assert.equal(__test.visibleUserHistoryText("## My request for Codex:\n旧格式请求"), "旧格式请求");
});

withRollout([
  row("2026-08-14T01:00:00.000Z", message("user-before-goal", "user", "visible before goal")),
  row("2026-08-14T01:00:01.000Z", message("assistant-before-goal", "assistant", "before goal reply", "final_answer")),
  row("2026-08-14T01:00:02.000Z", message(
    "goal-internal-user",
    "user",
    '<codex_internal_context source="goal">\n<objective>private goal</objective>\n</codex_internal_context>',
  )),
  row("2026-08-14T01:00:03.000Z", message("goal-internal-assistant", "assistant", "private goal work", "final_answer")),
  row("2026-08-14T01:00:04.000Z", message("user-after-goal", "user", "visible after goal")),
  row("2026-08-14T01:00:05.000Z", message("assistant-after-goal", "assistant", "after goal reply", "final_answer")),
], (file) => {
  const turns = __test.historyTurnsFromTail(file, "thread-goal-internal", 20);
  assert.equal(turns.length, 3);
  assert.deepEqual(
    turns.map((turn) => turn.messages.filter((item) => item.Type === "text").map((item) => item.Content)),
    [
      ["visible after goal", "after goal reply"],
      ["private goal", "private goal work"],
      ["visible before goal", "before goal reply"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(turns), /codex_internal_context/i);
});

async function verifyPageEndHasNoPagingFields() {
  const events = [];
  for await (const event of __test.readHistoryStream({ NativeThreadID: "00000000-0000-0000-0000-000000000000" }, { stream_id: "stream-1", live: true })) {
    events.push(event);
  }
  assert.deepEqual(events, [{ stream_id: "stream-1", type: "end", source: "initial", operation: "append" }]);
}

withRollout([
  row("2026-07-28T01:00:00.000Z", message("user-1", "user", "问题")),
  row("2026-07-28T01:00:01.000Z", { type: "task_started", turn_id: "turn-failed" }, "event_msg"),
  row("2026-07-28T01:00:02.000Z", { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "const r = await tools.exec_command({\"cmd\":\"sed -n '1,20p' src/main.js\"});" }),
  row("2026-07-28T01:00:03.000Z", message("assistant-final", "assistant", "已完成")),
  row("2026-07-28T01:00:04.000Z", { type: "task_complete" }, "event_msg"),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-2", 20);
  assert.equal(turn.messages[0].Role, "user");
  assert.deepEqual(turn.messages.map((item) => item.Type), ["text", "progress", "text"]);
  assert.equal(turn.messages[1].Status, "completed");
  assert.equal(turn.messages[1].Progress.Steps[0].Kind, "tool");
  assert.equal(turn.messages[2].Content, "已完成");
});

withRollout([
  row("2026-07-28T01:00:00.000Z", message("user-1", "user", "问题")),
  row("2026-07-28T01:00:01.000Z", { type: "task_started" }, "event_msg"),
  row("2026-07-28T01:00:02.000Z", { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "const r = await tools.exec_command({\"cmd\":\"sed -n '1,20p' src/main.js\"});" }),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-4", 20);
  assert.equal(turn.messages[1].Type, "progress");
  assert(turn.messages[1].Progress.Steps.some((item) => item.Title === "读取 src/main.js"));
});

withRollout([
  row("2026-07-28T01:00:00.000Z", { ...message("user-failed", "user", "这次会失败"), turn_id: "turn-failed" }),
  row("2026-07-28T01:00:01.000Z", { type: "task_started" }, "event_msg"),
  row("2026-07-28T01:00:03.000Z", {
    type: "task_complete",
    turn_id: "turn-failed",
    error: {
      message: "unexpected status 403 Forbidden: 预扣费额度失败 (request id: request-1), url: https://example.test/v1/responses",
    },
  }, "event_msg"),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-failed", 20);
  const progress = turn.messages[1];
  assert.equal(progress.Status, "failed");
  assert.match(progress.Content, /403 Forbidden/);
  assert.match(progress.Content, /request-1/);
  assert.equal(turn.messages.length, 2);
});

withRollout([
  row("2026-07-28T01:00:00.000Z", { ...message("user-interrupted", "user", "运行后停止"), turn_id: "turn-interrupted" }),
  row("2026-07-28T01:00:01.000Z", { type: "task_started", turn_id: "turn-interrupted" }, "event_msg"),
  row("2026-07-28T01:00:02.000Z", { type: "function_call", call_id: "call-stop", name: "exec", arguments: "{\"cmd\":\"sleep 120\"}" }),
  row("2026-07-28T01:00:27.000Z", { type: "turn_aborted", turn_id: "turn-interrupted", reason: "interrupted", duration_ms: 26000 }, "event_msg"),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-interrupted", 20);
  const progress = turn.messages[1];
  assert.equal(progress.Status, "interrupted");
  assert.equal(progress.Content, "已被打断");
  assert.equal(turn.messages.length, 2);
  assert(progress.Progress.Steps.some((item) => item.Kind === "tool"));
});

withRollout([
  row("2026-07-28T01:00:00.000Z", { ...message("user-interrupted-marker", "user", "运行后停止"), turn_id: "turn-interrupted-marker" }),
  row("2026-07-28T01:00:03.000Z", message("internal-turn-aborted", "user", "<turn_aborted duration_ms=\"2000\">interrupted</turn_aborted>")),
  row("2026-07-28T01:00:04.000Z", { type: "turn_aborted", turn_id: "turn-interrupted-marker", reason: "interrupted", duration_ms: 3000 }, "event_msg"),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-interrupted-marker", 20);
  assert.equal(turn.messages.length, 2);
  assert.equal(turn.messages[0].Content, "运行后停止");
  assert.equal(turn.messages[1].Status, "interrupted");
  assert.equal(turn.messages[1].Content, "已被打断");
  assert.doesNotMatch(JSON.stringify(turn), /turn_aborted/i);
});

withRollout([
  row("2026-07-28T01:00:00.000Z", { ...message("user-retrying", "user", "请继续"), turn_id: "turn-retrying" }),
  row("2026-07-28T01:00:01.000Z", { type: "task_started", turn_id: "turn-retrying" }, "event_msg"),
], (file) => {
  const threadID = "00000000-0000-0000-0000-000000000099";
  __test.updateHistoryRuntimeNotices(threadID, [{ title: "正在重新连接 5/5", status: "running" }]);
  const [turn] = __test.historyTurnsFromTail(file, threadID, 20);
  const progress = turn.messages[1];
  assert.equal(progress.Status, "running");
  assert(progress.Progress.Steps.some((item) => item.Kind === "status" && item.Title === "正在重新连接 5/5"));
});

withRollout(Array.from({ length: 22 }, (_, index) => [
  row(`2026-07-28T01:${String(index).padStart(2, "0")}:00.000Z`, message(`user-${index}`, "user", `问题 ${index}`)),
  row(`2026-07-28T01:${String(index).padStart(2, "0")}:01.000Z`, message(`assistant-${index}`, "assistant", `回答 ${index}`)),
]).flat(), (file) => {
  const turns = __test.historyTurnsFromTail(file, "thread-3", 20);
  assert.equal(turns.length, 20);
  assert(turns.every((turn) => turn.messages[0].Role === "user"));
});

withRollout([
  row("2026-07-28T01:00:00.000Z", message("hidden-user", "user", "<environment_context>hidden</environment_context>")),
  row("2026-07-28T01:00:01.000Z", { type: "task_started" }, "event_msg"),
  row("2026-07-28T01:00:02.000Z", { type: "function_call", call_id: "call-hidden", name: "wait", arguments: "{}" }),
  row("2026-07-28T01:00:03.000Z", message("visible-user", "user", "实际用户问题")),
  row("2026-07-28T01:00:04.000Z", message("assistant", "assistant", "正在处理", "commentary")),
], (file) => {
  const [turn] = __test.historyTurnsFromTail(file, "thread-5", 20);
  assert.equal(turn.messages[0].Content, "实际用户问题");
});

withRollout([
  row("2026-08-05T06:00:00.000Z", message("visible-user", "user", "请检查移动端历史")),
  row("2026-08-05T06:00:01.000Z", message("visible-assistant", "assistant", "正在检查", "commentary")),
  row("2026-08-05T06:00:02.000Z", message(
    "internal-assessment",
    "user",
    "The following is the Codex agent history whose request action you are assessing.\n\nCurrent Task\n- Internal task summary"
  )),
  row("2026-08-05T06:00:03.000Z", message("internal-decision", "assistant", '{"outcome":"allow"}')),
], (file) => {
  const turns = __test.historyTurnsFromTail(file, "thread-internal-assessment", 20);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messages[0].Content, "请检查移动端历史");
  assert.doesNotMatch(JSON.stringify(turns), /Current Task|outcome.*allow/i);
});

withRollout([
  row("2026-08-05T06:10:00.000Z", message("visible-user", "user", "保留这个问题")),
  row("2026-08-05T06:10:01.000Z", message(
    "internal-current-task",
    "assistant",
    "Current Task\n- Active repos: Prism\n- Remaining work: verify the queue menu",
    "commentary",
  )),
], (file) => {
  const turns = __test.historyTurnsFromTail(file, "thread-internal-current-task", 20);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messages[0].Content, "保留这个问题");
  assert.doesNotMatch(JSON.stringify(turns), /Current Task|Remaining work/i);
});

withRollout([
  row("2026-08-05T07:00:00.000Z", { type: "session_meta", cwd: "/tmp/old" }),
  ...Array.from({ length: 18000 }, (_, index) => row(
    "2026-08-05T07:00:01.000Z",
    { type: "message", role: "assistant", content: [{ type: "output_text", text: `old-${index}-${"x".repeat(120)}` }] },
  )),
  row("2026-08-05T08:00:00.000Z", { type: "task_started", turn_id: "turn-tail" }, "event_msg"),
  row("2026-08-05T08:00:01.000Z", { ...message("user-tail", "user", "latest request"), turn_id: "turn-tail" }),
  row("2026-08-05T08:00:02.000Z", { type: "function_call", call_id: "tail-call", name: "exec_command", arguments: "{\\\"cmd\\\":\\\"pwd\\\"}" }),
], (file) => {
  const boundedRows = __test.readRolloutItems(file);
  assert(boundedRows.length < 18003, "large rollout must not be retained as a full parsed array");
  const trace = __test.runTraceFromThread({ id: "00000000-0000-0000-0000-000000000123", rolloutPath: file });
  assert(trace.some((item) => item.kind === "tool"));
});

verifyPageEndHasNoPagingFields()
  .then(() => console.log("history stream tests passed"))
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
