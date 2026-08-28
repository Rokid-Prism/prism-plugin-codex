const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { __test } = require("../index.js");

test("legacy rollout messages without source ids keep one stable identity", () => {
  const row = {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "same desktop reply" }],
    },
  };

  const firstID = __test.historyMessageID(row, row.payload, "assistant");
  const secondID = __test.historyMessageID(row, row.payload, "assistant");

  assert.match(firstID, /^legacy-message-/);
  assert.equal(secondID, firstID);
});

test("tool output retains Codex's explicit running process sentinel", () => {
  const result = __test.historyToolResultFromRolloutRow({
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-running",
      output: "Chunk ID: abc\nProcess running with session ID 48291\nLive output:\n",
    },
  });

  assert.equal(result.Status, "running");
});

test("completed tool output does not infer running from ordinary text", () => {
  const result = __test.historyToolResultFromRolloutRow({
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-completed",
      output: "The running total is 42.",
    },
  });

  assert.equal(result.Status, "completed");
});

test("tool calls and results retain the same native call id in history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-call-id-"));
  const threadID = "11111111-1111-4111-8111-111111111111";
  const rollout = path.join(dir, `rollout-2026-08-03T00-00-00-${threadID}.jsonl`);
  const callID = "call-native-1";
  const rows = [
    { timestamp: "2026-08-03T00:00:00.000Z", type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: "inspect package" }] } },
    { timestamp: "2026-08-03T00:00:00.100Z", type: "response_item", payload: { type: "function_call", call_id: callID, name: "shell", arguments: '{"cmd":"pwd"}' } },
    { timestamp: "2026-08-03T00:00:00.200Z", type: "response_item", payload: { type: "function_call_output", call_id: callID, output: "/workspace" } },
  ];
  try {
    fs.writeFileSync(rollout, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const [turn] = __test.historyTurnsFromTail(rollout, threadID);
    const progress = turn.messages.find((message) => message.Type === "progress");
    const toolSteps = progress.Progress.Steps.filter((step) => step.Kind === "tool" || step.Kind === "tool_result");

    assert.deepEqual(toolSteps.map((step) => step.CallID), [callID, callID]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing rollout timestamps do not become watcher observation timestamps", () => {
  assert.equal(__test.asISOString(undefined), "");
  assert.equal(__test.asISOString("not-a-date"), "");

  const row = {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "same desktop reply" }],
    },
  };
  const messages = () => [{
    ID: __test.historyMessageID(row, row.payload, "assistant"),
    Role: "assistant",
    Type: "text",
    Content: "same desktop reply",
    Status: "",
    CreatedAt: __test.asISOString(undefined),
    UpdatedAt: __test.asISOString(undefined),
    Metadata: {},
  }];
  assert.equal(
    __test.historyMessageSignature(messages()),
    __test.historyMessageSignature(messages()),
  );
});

test("watcher signature exposes deterministic semantic components", () => {
  const snapshot = {
    runtime: {
      current_thread_id: "11111111-1111-4111-8111-111111111111",
      running: true,
      composer_available: true,
    },
    composer: {},
    thread: { metadata: {} },
  };
  const first = __test.desktopWatchSignatureParts(snapshot, "body-signature", null);
  const second = __test.desktopWatchSignatureParts(snapshot, "body-signature", null);

  assert.deepEqual(second, first);
  assert.equal(__test.desktopWatchSignature(snapshot, "body-signature", null), JSON.stringify(first));
});

test("watcher signature changes with goal and plan state", () => {
  const base = {
    runtime: {
      current_thread_id: "11111111-1111-4111-8111-111111111111",
      composer_available: true,
      plan_mode: { enabled: false, available: true },
      goal: { status: "none", objective: "", available: true },
    },
    composer: {},
    thread: { metadata: {} },
  };
  const changed = {
    ...base,
    runtime: {
      ...base.runtime,
      plan_mode: { enabled: true, available: true },
      goal: { status: "paused", objective: "Finish release", available: true },
    },
  };
  assert.notEqual(__test.desktopWatchSignature(base), __test.desktopWatchSignature(changed));
  const detail = __test.detailSnapshotFromDesktopWatch(
    "11111111-1111-4111-8111-111111111111",
    changed,
  );
  assert.equal(detail.plan_mode.enabled, true);
  assert.equal(detail.goal.status, "paused");
  assert.equal(detail.goal.objective, "Finish release");
});

test("plugin-wide index watcher ignores body and composer churn", () => {
  const snapshot = {
    runtime: {
      current_thread_id: "11111111-1111-4111-8111-111111111111",
      running: true,
      composer_text: "first draft",
    },
    thread: { title: "Stable conversation", metadata: {} },
    pinned: false,
  };
  const changedDetail = {
    ...snapshot,
    runtime: { ...snapshot.runtime, composer_text: "second draft" },
  };

  assert.equal(
    __test.desktopIndexWatchSignature(snapshot, "running"),
    __test.desktopIndexWatchSignature(changedDetail, "running"),
  );
  assert.notEqual(
    __test.desktopIndexWatchSignature(snapshot, "running"),
    __test.desktopIndexWatchSignature(snapshot, "completed"),
  );
});

test("plugin-wide watcher publishes plan and goal control changes", () => {
  const snapshot = {
    runtime: {
      current_thread_id: "11111111-1111-4111-8111-111111111111",
      plan_mode: { enabled: false, available: true },
      goal: { status: "none", objective: "", available: true },
    },
    thread: { title: "Stable conversation", metadata: {} },
  };
  const changed = {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      plan_mode: { enabled: true, available: true },
      goal: { status: "running", objective: "Finish release", available: true },
    },
  };

  assert.notEqual(
    __test.desktopIndexWatchSignature(snapshot, "idle"),
    __test.desktopIndexWatchSignature(changed, "idle"),
  );
});

test("grouped intelligence sessions expose only opaque group and entry identities", () => {
  const session = __test.createPluginMenuSession(
    "11111111-1111-4111-8111-111111111111",
    { kind: "interactive_control", control_id: "codex.intelligence" },
    [],
    "",
    [
      {
        control_id: "native-root-model",
        label: "Desktop model root",
        rows: [{ optionId: "native-model-a", label: "Model A", checked: true }],
      },
      {
        control_id: "native-root-reasoning",
        label: "Desktop reasoning root",
        rows: [{ optionId: "native-reasoning-b", label: "Reasoning B" }],
      },
    ],
  );

  assert.equal(session.entries.length, 2);
  assert.equal(session.groups.length, 2);
  assert.deepEqual(session.groups.map((group) => group.entries[0].entry_id), session.entries.map((entry) => entry.entry_id));
  assert.equal(session.entries[0].current, true);
  assert.equal(session.groups[0].entries[0].current, true);
  assert.doesNotMatch(JSON.stringify(session), /native-root|native-model|native-reasoning/);
});

test("conversation header sessions expose only opaque entry identities", () => {
  const session = __test.createPluginMenuSession(
    "11111111-1111-4111-8111-111111111111",
    { kind: "conversation" },
    [{ optionId: "native-header-handler-fingerprint", label: "Desktop action" }],
  );

  assert.equal(session.entries.length, 1);
  assert.match(session.entries[0].entry_id, /^codex-entry-/);
  assert.doesNotMatch(JSON.stringify(session), /native-header-handler-fingerprint/);
});

test("later task start does not make a completed prior turn replay as running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-history-"));
  const rollout = path.join(dir, "rollout-2026-08-03T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  const firstTurnID = "turn-one";
  const secondTurnID = "turn-two";
  const rows = [
    { timestamp: "2026-08-03T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: firstTurnID } },
    { timestamp: "2026-08-03T00:00:00.100Z", type: "response_item", payload: { type: "message", id: "user-one", role: "user", content: [{ type: "input_text", text: "first request" }], internal_chat_message_metadata_passthrough: { turn_id: firstTurnID } } },
    { timestamp: "2026-08-03T00:00:01.000Z", type: "response_item", payload: { type: "message", id: "assistant-one", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "first reply" }], internal_chat_message_metadata_passthrough: { turn_id: firstTurnID } } },
    { timestamp: "2026-08-03T00:00:01.100Z", type: "event_msg", payload: { type: "task_complete", turn_id: firstTurnID } },
    { timestamp: "2026-08-03T00:00:02.000Z", type: "event_msg", payload: { type: "task_started", turn_id: secondTurnID } },
    { timestamp: "2026-08-03T00:00:02.100Z", type: "response_item", payload: { type: "message", id: "user-two", role: "user", content: [{ type: "input_text", text: "second request" }], internal_chat_message_metadata_passthrough: { turn_id: secondTurnID } } },
  ];
  try {
    fs.writeFileSync(rollout, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const turns = __test.historyTurnsFromTail(rollout, "11111111-1111-4111-8111-111111111111");
    const first = turns.find((turn) => turn.turn_id === "user-one");
    const second = turns.find((turn) => turn.turn_id === "user-two");

    assert.equal(first.messages[1].Progress.Status, "completed");
    assert.match(first.messages[1].Content, /^已处理 /);
    assert.equal(second.messages[1].Progress.Status, "running");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live Desktop approval is not replaced by an older completed rollout turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-terminal-"));
  const threadID = "11111111-1111-4111-8111-111111111111";
  const rollout = path.join(dir, `rollout-2026-08-03T00-00-00-${threadID}.jsonl`);
  const turnID = "turn-complete";
  const rows = [
    { timestamp: "2026-08-03T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnID } },
    { timestamp: "2026-08-03T00:00:00.100Z", type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: "request" }], internal_chat_message_metadata_passthrough: { turn_id: turnID } } },
    { timestamp: "2026-08-03T00:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnID } },
  ];
  try {
    fs.writeFileSync(rollout, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const terminal = __test.latestRecordedTurnLifecycle(rollout, threadID);
    const runtime = __test.runtimeWithRecordedTerminal({
      current_thread_id: threadID,
      waiting_approval: true,
      approval: { approval_request_id: "live:approval" },
      primary_action: "approval",
    }, terminal);

    assert.equal(terminal.status, "completed");
    assert.equal(runtime.waiting_approval, true);
    assert.equal(runtime.approval.approval_request_id, "live:approval");
    assert.equal(runtime.primary_action, "approval");
    assert.equal(runtime.recorded_terminal, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("completed rollout remains the fallback when Desktop has no live state", () => {
  const runtime = __test.runtimeWithRecordedTerminal({
    current_thread_id: "11111111-1111-4111-8111-111111111111",
    running: false,
    waiting_approval: false,
    primary_action: "send",
  }, {
    terminal: true,
    status: "completed",
    completedAt: "2026-08-03T00:00:01.000Z",
  });

  assert.equal(runtime.running, false);
  assert.equal(runtime.primary_action, "send");
  assert.equal(runtime.recorded_terminal.status, "completed");
});
