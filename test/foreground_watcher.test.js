const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";

test("foreground watcher marks a desktop switch before the next detail", () => {
  const state = __test.createDesktopWatchState();
  assert.equal(__test.observeDesktopWatchForeground(state, THREAD_A).switched, false);

  const transition = __test.observeDesktopWatchForeground(state, THREAD_B);
  assert.equal(transition.valid, true);
  assert.equal(transition.previousThreadID, THREAD_A);
  assert.equal(transition.switched, true);
  assert.equal(transition.recovered, false);
});

test("foreground watcher reports unavailable once after three invalid polls and recovers on detail", () => {
  const state = __test.createDesktopWatchState();
  __test.observeDesktopWatchForeground(state, THREAD_A);

  assert.equal(__test.observeDesktopWatchForeground(state, "").becameUnavailable, false);
  assert.equal(__test.observeDesktopWatchForeground(state, "").becameUnavailable, false);
  assert.equal(__test.observeDesktopWatchForeground(state, "").becameUnavailable, true);
  assert.equal(__test.observeDesktopWatchForeground(state, "").becameUnavailable, false);

  const recovery = __test.observeDesktopWatchForeground(state, THREAD_B);
  assert.equal(recovery.valid, true);
  assert.equal(recovery.recovered, true);
  assert.equal(state.consecutiveInvalidPolls, 0);
  assert.equal(state.unavailable, false);
});

test("watch queue keeps only the newest replaceable state for one thread", async () => {
  const queue = __test.createDesktopWatchEventQueue(null, { maxPending: 2 });
  queue.push({
    Type: "desktop.state.changed",
    Payload: { native_session: { native_thread_id: THREAD_A }, revision: 1 },
  });
  queue.push({
    Type: "desktop.state.changed",
    Payload: { native_session: { native_thread_id: THREAD_A }, revision: 2 },
  });

  const next = await queue.next();
  assert.equal(next.done, false);
  assert.equal(next.value.Payload.revision, 2);
  queue.close();
});

test("watch queue closes instead of silently dropping lifecycle events on overload", async () => {
  const queue = __test.createDesktopWatchEventQueue(null, { maxPending: 1 });
  queue.push({ Type: "desktop.session.archived", Payload: { native_session: { native_thread_id: THREAD_A } } });
  queue.push({ Type: "desktop.draft.stale", Payload: { draft_id: "draft-1" } });

  const delivered = await queue.next();
  assert.equal(delivered.done, false);
  assert.equal(delivered.value.Type, "desktop.session.archived");
  const closed = await queue.next();
  assert.equal(closed.done, true);
});
