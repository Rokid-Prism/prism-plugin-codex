const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { __test } = require("../index.js");

const goalEnvelope = [
  '<codex_internal_context source="goal">',
  '  <objective>',
  '    Keep this exact user goal in the visible conversation body.',
  '  </objective>',
  '  <continuation>private runtime instructions</continuation>',
  '</codex_internal_context>',
].join("\n");

test("goal protocol envelope projects only its objective as a visible user turn", () => {
  const row = {
    type: "response_item",
    timestamp: "2026-08-18T14:29:00.858Z",
    payload: {
      type: "message",
      id: "goal-message-1",
      role: "user",
      content: [{ type: "input_text", text: goalEnvelope }],
      internal_chat_message_metadata_passthrough: { turn_id: "goal-turn-1" },
    },
  };

  assert.equal(
    __test.goalObjectiveFromInternalUserEnvelope(goalEnvelope),
    "Keep this exact user goal in the visible conversation body.",
  );
  assert.deepEqual(__test.historyMessageFromRolloutRow(row, "thread-1"), {
    ID: "goal-message-1",
    TurnID: "goal-turn-1",
    Role: "user",
    Type: "text",
    Phase: "",
    Content: "Keep this exact user goal in the visible conversation body.",
    Status: "",
    CreatedAt: "2026-08-18T14:29:00.858Z",
    UpdatedAt: "2026-08-18T14:29:00.858Z",
    Metadata: {},
  });
});

test("non-goal internal envelopes remain hidden", () => {
  const approvalEnvelope = '<codex_internal_context source="approval"><objective>never expose this</objective></codex_internal_context>';
  assert.equal(__test.goalObjectiveFromInternalUserEnvelope(approvalEnvelope), "");
  assert.equal(__test.historyMessageFromRolloutRow({
    type: "response_item",
    payload: {
      type: "message",
      id: "approval-message-1",
      role: "user",
      content: [{ type: "input_text", text: approvalEnvelope }],
    },
  }, "thread-1"), null);
});

test("active goal remains in the bounded body window without exposing its envelope", () => {
  const threadID = "11111111-1111-4111-8111-111111111111";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-goal-window-"));
  const rollout = path.join(dir, "rollout.jsonl");
  try {
    const rows = ["first", "latest"].flatMap((text, index) => [{
      type: "response_item",
      timestamp: `2026-08-18T14:2${index}:00.000Z`,
      payload: {
        type: "message", id: `user-${index}`, role: "user",
        content: [{ type: "input_text", text }],
      },
    }, {
      type: "response_item",
      timestamp: `2026-08-18T14:2${index}:01.000Z`,
      payload: {
        type: "message", id: `assistant-${index}`, role: "assistant",
        content: [{ type: "output_text", text: `reply-${index}` }],
      },
    }]);
    fs.writeFileSync(rollout, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    __test.rememberVisibleGoalBody(threadID, {
      status: "running",
      objective: "Keep this active objective in the normal conversation body.",
    });

    const turns = __test.historyTurnsFromTail(rollout, threadID, 1);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].messages[0].Content, "latest");
    assert.equal(turns[1].messages[0].Role, "user");
    assert.equal(turns[1].messages[0].Content, "Keep this active objective in the normal conversation body.");
    assert.deepEqual(turns[1].messages[0].Metadata, { synthetic: "goal" });
  } finally {
    __test.rememberVisibleGoalBody(threadID, { status: "none" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projected active goal keeps retained assistant output in the same body turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-goal-output-"));
  try {
    const threadID = "22222222-2222-4222-8222-222222222222";
    assert.equal(__test.rememberVisibleGoalBodyFromForegroundRuntime(threadID, {
      current_thread_id: threadID,
      goal: { status: "running", objective: "Finish the migration." },
    }), true);
    const rollout = path.join(dir, `${threadID}.jsonl`);
    fs.writeFileSync(rollout, [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", id: "goal-reply", content: [{ type: "output_text", text: "Migration is running." }] },
      }),
    ].join("\n"));

    const turns = __test.historyTurnsFromTail(rollout, threadID, 5);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].messages[0].Content, "Finish the migration.");
    assert.ok(turns[0].messages.some((message) => message.Content === "Migration is running."));
  } finally {
    __test.rememberVisibleGoalBody("22222222-2222-4222-8222-222222222222", { status: "none" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
