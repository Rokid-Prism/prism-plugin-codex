const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { __test } = require("../index.js");

test("queue menu rows preserve only opaque runtime option ids", () => {
  const rows = __test.menuSessionRows([
    { id: "queue.item.menu.8a2f", label: "Edit message", disabled: false },
    { option_id: "queue.item.menu.e910", label: "Delete message", disabled: true },
  ]);

  assert.deepEqual(rows, [
    { option_id: "queue.item.menu.8a2f", label: "Edit message", disabled: false, current: false },
    { option_id: "queue.item.menu.e910", label: "Delete message", disabled: true, current: false },
  ]);
});

test("queue control target only accepts the opaque queue item id", () => {
  assert.equal(__test.queueItemIDFromTarget({ queue_item_id: "native-message-1" }), "native-message-1");
  assert.equal(__test.queueItemIDFromTarget({ message_id: "wrong-field" }), "");
  assert.equal(__test.queueItemIDFromTarget("native-message-1"), "");
});

test("queue signature changes when the native more-actions capability changes", () => {
  const base = {
    items: [{
      id: "native-message-1",
      content: "queued input",
      actions: [{ id: "queue.item.direct.guide", label: "Guide", available: true }],
      has_more_actions: false,
    }],
    actions: [],
  };
  const menuAvailable = {
    ...base,
    items: [{ ...base.items[0], has_more_actions: true }],
  };
  assert.notEqual(__test.queueDirectSignature(base), __test.queueDirectSignature(menuAvailable));
});

test("queue snapshots never open or sample native item menus", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");
  const start = source.indexOf("  async queuedMessageState()");
  const end = source.indexOf("\n  async openQueuedMessageMenu", start);
  const method = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(method, /openQueuedMessageMenu|includeMenuActions|queueVisibleMenuRows/);
  assert.match(method, /queueItemDescriptors/);
});

test("queue menu filtering uses Codex vector identities, never localized labels", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");
  const start = source.indexOf("    const queueMenuIconIdentity =");
  const end = source.indexOf("    const queueRemoteActionDescriptor =", start);
  const helper = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(helper, /edit_message/);
  assert.match(helper, /close_queue/);
  assert.match(helper, /desktop_side_chat/);
  assert.doesNotMatch(helper, /编辑消息|在侧边聊天中打开|关闭排队|Edit message|Open in side chat|Close queue/);
});

test("direct queue actions never fall back to a native menu", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");
  const start = source.indexOf("  async executeQueuedMessageAction(");
  const end = source.indexOf("\n  async currentThreadId()", start);
  const method = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(method, /openQueuedMessageMenu|item\.menu|queueVisibleMenuRows/);
  assert.match(method, /queueDirectActionElements/);
});

test("direct queue action execution preserves the snapshot candidate order", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");
  const start = source.indexOf("    const queueDirectActionElements = (itemID) => {");
  const end = source.indexOf("    const queueItemEntries = () => {", start);
  const helper = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(helper, /return queueNamedDirectActions\(entry\.root, itemID\);/);
  assert.doesNotMatch(helper, /entry\.root\.querySelectorAll/);
});

test("queue controls do not wait behind a menu session opened for the same item", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const start = source.indexOf("async function controlCodexQueue");
  const end = source.indexOf("\nasync function applyCodexInteractiveSurface", start);
  const method = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(method, /await controller\.executeQueuedMessageAction\(normalizedAction, itemID\)/);
  assert.doesNotMatch(method, /runExclusiveDesktopControl/);
  assert.match(method, /scheduleDesktopWatchBurst\(threadID, "queue\.control"\)/);
});
