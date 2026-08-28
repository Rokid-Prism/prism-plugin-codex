const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { __test } = require("../index.js");

test("foreground detail context is derived from the rollout token event", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-context-"));
  const rollout = path.join(dir, "rollout-2026-07-26T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  try {
    fs.writeFileSync(rollout, `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 258400,
          last_token_usage: {
            input_tokens: 120100,
            output_tokens: 252,
            total_tokens: 120352,
          },
        },
      },
    })}\n`);

    const thread = __test.withRolloutContextMetadata({
      id: "11111111-1111-4111-8111-111111111111",
      rolloutPath: rollout,
      metadata: { model: "5.5" },
    });

    assert.deepEqual(__test.rolloutContextMetadata(rollout), {
      context_tokens_used: "120352",
      context_window_total: "258400",
      context_window_usage_percent: "47",
      context_window: "上下文窗口 258400",
    });
    assert.equal(thread.metadata.model, "5.5");
    assert.equal(thread.metadata.context_window_total, "258400");
    assert.equal(thread.metadata.context_tokens_used, "120352");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
