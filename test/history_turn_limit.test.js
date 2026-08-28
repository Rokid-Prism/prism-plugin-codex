"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { __test } = require("../index.js");

test("history stream honors the API-provided window within its fixed safety bounds", () => {
  assert.equal(__test.boundedHistoryTurnLimit(5), 5);
  assert.equal(__test.boundedHistoryTurnLimit(1), 1);
  assert.equal(__test.boundedHistoryTurnLimit(21), 20);
  assert.equal(__test.boundedHistoryTurnLimit(0), 20);
  assert.equal(__test.boundedHistoryTurnLimit(undefined), 20);
});

test("recent rollout scan budget scales with the requested turn window", () => {
  assert.equal(__test.historyRecentScanBudget(1), 16 * 1024 * 1024);
  assert.equal(__test.historyRecentScanBudget(5), 16 * 1024 * 1024);
  assert.equal(__test.historyRecentScanBudget(20), 40 * 1024 * 1024);
});

test("recent rollout scanning stays within its tail budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-history-budget-"));
  const rollout = path.join(dir, "rollout.jsonl");
  try {
    // The valid newest row remains readable even when old data is far beyond
    // the remote history scan budget.
    fs.writeFileSync(rollout, `${"x".repeat(5 * 1024 * 1024)}\n${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "latest-user",
        role: "user",
        content: [{ type: "input_text", text: "latest" }],
      },
    })}\n`);
    const rows = __test.readRecentRolloutRows(rollout, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.id, "latest-user");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recent rollout scanning finds a user anchor beyond the legacy four megabyte tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-history-long-turn-"));
  const rollout = path.join(dir, "rollout.jsonl");
  try {
    const user = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "long-turn-user",
        role: "user",
        content: [{ type: "input_text", text: "keep this turn visible" }],
      },
    });
    const largeResult = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "large-result",
        output: "x".repeat(5 * 1024 * 1024),
      },
    });
    fs.writeFileSync(rollout, `${user}\n${largeResult}\n`);

    const rows = __test.readRecentRolloutRows(rollout, 1);

    assert.equal(rows[0].payload.id, "long-turn-user");
    assert.equal(rows.at(-1).payload.call_id, "large-result");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
