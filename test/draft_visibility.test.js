const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { __test } = require("../index.js");

function withRollout(rows, verify) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-draft-visibility-"));
  const file = path.join(directory, "rollout.jsonl");
  try {
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    verify(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("draft visibility matches decoded multiline user text", () => {
  const marker = "Reply exactly PRISM_DRAFT_E2E_REPLY\no";
  withRollout([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${marker}\n` }],
      },
    },
  ], (file) => {
    assert.equal(__test.rolloutContainsVisibilityMarker(file, marker), true);
  });
});

test("draft visibility does not accept an assistant-only marker", () => {
  const marker = "PRISM_DRAFT_E2E_REPLY";
  withRollout([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: marker }],
      },
    },
  ], (file) => {
    assert.equal(__test.rolloutContainsVisibilityMarker(file, marker), false);
  });
});
