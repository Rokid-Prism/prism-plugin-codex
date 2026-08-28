const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

test("watcher retains a verified menu id for the same Fiber model value", () => {
  const cached = [{
    id: "codex.model:5.5",
    key: "gpt-5.5",
    label: "5.5",
    displayName: "GPT-5.5",
    menuIndex: 1,
    menuVerified: true,
  }];
  const observed = [{
    id: "gpt-5.5",
    key: "gpt-5.5",
    label: "5.5",
    displayName: "GPT-5.5",
    source: "desktop-state",
  }];

  const first = __test.watcherCurrentControlOption(cached, observed, observed[0]);
  const second = __test.watcherCurrentControlOption(cached, observed, observed[0]);

  assert.equal(first.id, "codex.model:5.5");
  assert.equal(second.id, "codex.model:5.5");
  assert.equal(first.menuVerified, true);

  const signature = (model) => __test.desktopWatchSignature({
    runtime: { current_thread_id: "11111111-1111-4111-8111-111111111111" },
    composer: { model },
  });
  assert.equal(signature(first), signature(second));
});

test("watcher selects the verified row for a real current-value change", () => {
  const cached = [{
    id: "codex.model:5.5",
    key: "gpt-5.5",
    displayName: "GPT-5.5",
    menuIndex: 1,
    menuVerified: true,
  }, {
    id: "codex.model:5.6",
    key: "gpt-5.6",
    displayName: "GPT-5.6",
    menuIndex: 2,
    menuVerified: true,
  }];
  const changed = {
    id: "gpt-5.6",
    key: "gpt-5.6",
    displayName: "GPT-5.6",
    source: "desktop-state",
  };

  const current = __test.watcherCurrentControlOption(cached, [], changed);

  assert.equal(current.id, "codex.model:5.6");
  assert.equal(current.menuIndex, 2);
});
