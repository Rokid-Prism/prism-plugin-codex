const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

test("an empty readable anonymous desktop draft can be replaced", () => {
  assert.equal(__test.isReplaceableAnonymousDraft({
    current_thread_id: "",
    client_thread_id: "client-draft-1",
    composer_text: "",
    composer_available: true,
    running: false,
    waiting_approval: false,
  }), true);
});

test("a non-empty anonymous desktop draft is never replaced", () => {
  assert.equal(__test.isReplaceableAnonymousDraft({
    current_thread_id: "",
    client_thread_id: "client-draft-1",
    composer_text: "user's unsent work",
    composer_available: true,
  }), false);
});

test("fresh draft waiting keeps the existing thread behavior", async () => {
  const calls = [];
  await __test.waitForFreshCodexDraft({
    waitForFreshDraft: async (...args) => calls.push(args),
  }, { current_thread_id: THREAD_ID }, 450);
  assert.deepEqual(calls, [[THREAD_ID, 450]]);
});

test("fresh draft waiting detects an anonymous client draft change", async () => {
  const snapshots = [{
    current_thread_id: "",
    client_thread_id: "client-draft-2",
    composer_text: "",
    composer_available: true,
  }];
  await __test.waitForFreshCodexDraft({
    currentThreadRuntimeState: async () => snapshots.shift(),
  }, {
    current_thread_id: "",
    client_thread_id: "client-draft-1",
    composer_text: "",
    composer_available: true,
  }, 450);
});

test("fresh draft waiting accepts Codex reusing an already-empty anonymous draft", async () => {
  await __test.waitForFreshCodexDraft({
    currentThreadRuntimeState: async () => ({
      current_thread_id: "",
      client_thread_id: "client-draft-1",
      composer_text: "",
      composer_available: true,
    }),
  }, {
    current_thread_id: "",
    client_thread_id: "client-draft-1",
    composer_text: "",
    composer_available: true,
  }, 450);
});
