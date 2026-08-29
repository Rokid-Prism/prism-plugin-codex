const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CodexDesktopController,
  isCodexMainPageTarget,
  probeCodexMainPage,
  selectCodexMainPageTarget,
} = require("../codex_cdp.js");
const { __test } = require("../index.js");

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function selectionController(overrides = {}) {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.ensureReady = async () => {};
  controller.isThreadSelected = async () => false;
  controller.openThreadByDeepLink = async () => {};
  return Object.assign(controller, overrides);
}

test("deep-link selection does not require a title", async () => {
  let selected = "";
  const controller = selectionController({
    openThreadByDeepLink: async (threadID) => {
      selected = threadID;
    },
  });

  assert.deepEqual(await controller.selectThread(THREAD_ID), { selected: true, alreadySelected: false });
  assert.equal(selected, THREAD_ID);
});

test("already foreground thread does not invoke the deep link", async () => {
  let calls = 0;
  const controller = selectionController({
    isThreadSelected: async () => true,
    openThreadByDeepLink: async () => {
      calls += 1;
    },
  });
  assert.deepEqual(await controller.selectThread(THREAD_ID), { selected: true, alreadySelected: true });
  assert.equal(calls, 0);
});

test("selection timeout returns a structured incomplete result", async () => {
  const controller = selectionController({
    openThreadByDeepLink: async () => {
      throw new Error("deep link select timeout after 4000ms");
    },
  });

  assert.deepEqual(await controller.selectThread(THREAD_ID), {
    selected: false,
    alreadySelected: false,
    reason: "thread_row_not_visible",
  });
});

test("foreground thread detection uses only the main conversation attribute", async () => {
  let script = "";
  const controller = selectionController({
    evaluate: async (source) => {
      script = source;
      return THREAD_ID;
    },
  });

  assert.equal(await controller.currentThreadId(), THREAD_ID);
  assert.match(script, /data-above-composer-conversation-id/);
  assert.doesNotMatch(script, /data-app-action-sidebar-thread/);
  assert.doesNotMatch(script, /window\.location/);
});

test("composer control readiness is a read-only check scoped to the selected thread", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let script = "";
  controller.evaluate = async (source) => {
    script = source;
    return { selected: true, composer: true, intelligence: true, permission: true };
  };

  assert.deepEqual(await controller.composerControlReadiness(THREAD_ID), {
    selected: true,
    composer: true,
    intelligence: true,
    permission: true,
  });
  assert.match(script, /data-above-composer-conversation-id/);
  assert.match(script, /data-codex-intelligence-trigger/);
  assert.match(script, /data-composer-navigation-target="permissions"/);
  assert.match(script, new RegExp(THREAD_ID));
  assert.doesNotMatch(script, /\.click\(/);
  assert.doesNotMatch(script, /dispatchEvent/);
});

test("watcher snapshots disable menu sampling and never schedule a warm-up", () => {
  const source = require("node:fs").readFileSync(require.resolve("../index.js"), "utf8");
  const watcher = source.slice(source.indexOf("async function pollDesktopWatch"), source.indexOf("function ensureDesktopWatchRunning"));

  assert.match(watcher, /allowMenuSampling: false/);
  assert.doesNotMatch(watcher, /warmInteractiveControlsIfNeeded/);
  assert.doesNotMatch(watcher, /enqueueDesktopControlMenuWarm/);
});

test("directory diff isolates index changes from confirmed removals", () => {
  const before = [{
    id: THREAD_ID,
    title: "A title",
    cwd: "/tmp/project",
    metadata: { sort_at_ms: "100", pinned: "false" },
  }];
  const initial = __test.desktopDirectoryDiff(new Map(), before);
  assert.equal(initial.added.length, 1);
  const renamed = __test.desktopDirectoryDiff(initial.next, [{ ...before[0], title: "Renamed" }]);
  assert.equal(renamed.added.length, 0);
  assert.equal(renamed.changed.length, 1);
  const removed = __test.desktopDirectoryDiff(renamed.next, []);
  assert.equal(removed.removed.length, 1);
});

test("only the Plugin-wide subscription owns the directory watcher", () => {
  const source = require("node:fs").readFileSync(require.resolve("../index.js"), "utf8");
  const single = source.slice(source.indexOf("async function* subscribe(session"), source.indexOf("async function* subscribePlugin"));
  const wide = source.slice(source.indexOf("async function* subscribePlugin"), source.indexOf("async function interrupt"));

  assert.doesNotMatch(single, /ensureDesktopDirectoryWatchRunning/);
  assert.match(wide, /ensureDesktopDirectoryWatchRunning\(\)/);
  assert.match(wide, /stopDesktopDirectoryWatchWhenIdle\(\)/);
});

test("directory watcher includes Codex rollout files for desktop-originated threads", () => {
  const paths = __test.directoryWatchPaths();
  const sessionsPath = paths.find((value) => value.replace(/\\/g, "/").endsWith("/.codex/sessions"));
  assert(sessionsPath);
  assert.equal(__test.directoryWatchEventIsRelevant(sessionsPath, "new-rollout.jsonl"), true);
});

test("Codex CDP target selection ignores auxiliary pages", () => {
  const targets = [
    { type: "page", url: "data:text/html,about", webSocketDebuggerUrl: "ws://about" },
    { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://overlay" },
    { type: "page", url: "app://-/index.html#auxiliary", webSocketDebuggerUrl: "ws://fragment" },
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://main" },
  ];

  assert.equal(isCodexMainPageTarget(targets[0]), false);
  assert.equal(isCodexMainPageTarget(targets[1]), false);
  assert.equal(isCodexMainPageTarget(targets[2]), false);
  assert.equal(isCodexMainPageTarget(targets[3]), true);
  assert.deepEqual(selectCodexMainPageTarget(targets), targets[3]);
  assert.equal(selectCodexMainPageTarget([targets[0]]), null);
  assert.equal(selectCodexMainPageTarget(targets.slice(0, 3)), null);
});

test("CDP capability probe is a bounded main-page reachability check", () => {
  const source = require("node:fs").readFileSync(require.resolve("../codex_cdp.js"), "utf8");
  assert.equal(typeof probeCodexMainPage, "function");
  const probe = source.slice(source.indexOf("async function probeCodexMainPage"), source.indexOf("function singletonArtifacts"));
  assert.match(probe, /AbortSignal\.timeout\(2000\)/);
  assert.match(probe, /selectCodexMainPageTarget/);
  assert.match(probe, /for \(let attempt = 0; attempt < attempts; attempt \+= 1\)/);
  assert.doesNotMatch(probe, /launchManagedTarget/);
  assert.doesNotMatch(probe, /waitForReady/);
});

test("CDP capability probe tolerates the DevTools target publication race", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false };
    return {
      ok: true,
      json: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" }],
    };
  };
  try {
    assert.equal(await probeCodexMainPage({ cdpUrl: "http://127.0.0.1:19999", attempts: 2, retryDelayMs: 1 }), true);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("approval discovery supports Codex's inline approval surface", () => {
  const source = require("node:fs").readFileSync(require.resolve("../codex_cdp.js"), "utf8");
  const helpers = source.slice(source.indexOf("function approvalDOMHelpersSource"), source.indexOf("function queueDOMHelpersSource"));

  assert.match(helpers, /data-codex-approval-surface/);
  assert.match(helpers, /findApprovalActionSurface/);
  assert.match(helpers, /approvalActionHandler/);
  assert.match(helpers, /prism\.codex\.approval-interactions\.v1/);
  assert.match(helpers, /approvalActionMatches/);
  assert.doesNotMatch(helpers, /批准|拒绝|允许|approve|reject|deny|learn more|了解更多/i);
});

test("workspace readiness supports bound conversations and anonymous drafts", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.options = {};
  let readinessScript = "";
  controller.waitFor = async (source) => {
    readinessScript = source;
  };

  await controller.waitForReady();

  assert.match(readinessScript, /data-above-composer-conversation-id/);
  assert.doesNotMatch(readinessScript, /data-app-action-sidebar-thread-row/);
  assert.match(readinessScript, /data-codex-composer/);
});

test("anonymous draft runtime exposes only Codex's opaque client thread fingerprint", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.ensureReady = async () => {};
  let runtimeScript = "";
  controller.evaluate = async (source) => {
    runtimeScript = source;
    return { current_thread_id: "", client_thread_id: "client-new-thread:test" };
  };

  assert.deepEqual(await controller.currentThreadRuntimeState(), {
    current_thread_id: "",
    client_thread_id: "client-new-thread:test",
  });
  assert.match(runtimeScript, /clientThreadId/);
  assert.match(runtimeScript, /client_thread_id/);
});

test("anonymous draft fingerprint is never derived from a bound conversation", () => {
  assert.equal(__test.anonymousDraftFingerprint({ current_thread_id: THREAD_ID, client_thread_id: "client-new-thread:test" }), "");
  assert.equal(__test.anonymousDraftFingerprint({ current_thread_id: "", client_thread_id: "client-new-thread:test" }), "client-new-thread:test");
  assert.equal(__test.anonymousDraftFingerprint({ current_thread_id: "" }), "");
});

test("anonymous draft watcher stales only a different fingerprint", () => {
  const current = { current_thread_id: "", client_thread_id: "client-new-thread:current" };
  assert.equal(__test.isCurrentAnonymousMobileDraft({ client_thread_id: "client-new-thread:current" }, current), true);
  assert.equal(__test.isCurrentAnonymousMobileDraft({ client_thread_id: "client-new-thread:other" }, current), false);
  assert.equal(__test.isCurrentAnonymousMobileDraft({ client_thread_id: "client-new-thread:current" }, { current_thread_id: THREAD_ID }), false);
});

test("project creation resolves Codex's opaque project id from the exact cwd", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let script = "";
  controller.evaluate = async (source) => {
    script = source;
    return "local-project-42";
  };

  assert.equal(
    await controller.projectIdForCwd("/Users/xin.he/go/rokid-prism-hub"),
    "local-project-42",
  );
  assert.match(script, /value\.path === requestedCwd/);
  assert.match(script, /value\.projectId/);
  assert.doesNotMatch(script, /project-label|data-app-action-sidebar-project-label/);
});

test("project creation fails explicitly when Codex has no exact cwd mapping", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async () => "";

  await assert.rejects(
    controller.projectIdForCwd("/Users/xin.he/go/rokid-prism-hub"),
    /codex_project_not_visible_for_cwd/,
  );
});

test("project creation uses the unique project-bound new-thread owner", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let clicked = "";
  controller.ensureReady = async () => {};
  controller.projectIdForCwd = async () => "local-project-42";
  controller.waitFor = async () => true;
  controller.ensureProjectExpanded = async () => ({ expanded: true, alreadyExpanded: true });
  controller.clickDomElement = async (source) => {
    clicked = source;
  };

  await controller.startNewThreadInProject("/Users/xin.he/go/rokid-prism-hub");
  assert.match(clicked, /expectedProjectID/);
  assert.match(clicked, /requestedCwd/);
  assert.match(clicked, /canStartNewThread === true/);
  assert.match(clicked, /onStartNewThread === 'function'/);
  assert.match(clicked, /!element\.hasAttribute\('aria-haspopup'\)/);
  assert.match(clicked, /candidates\.length === 1/);
  assert.doesNotMatch(clicked, /querySelectorAll\('button'\)\.find/);
  assert.doesNotMatch(clicked, /New chat|新对话|keyPress/);
});

test("global draft creation uses the unique Fiber owner without a shortcut or label", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let clicked = "";
  controller.ensureReady = async () => {};
  controller.waitFor = async () => true;
  controller.clickDomElement = async (source) => {
    clicked = source;
  };

  await controller.startNewProjectlessThread();

  assert.match(clicked, /homeComposerMode/);
  assert.match(clicked, /showQuickChatButton/);
  assert.match(clicked, /hooksHaveStartNewConversation/);
  assert.match(clicked, /candidates\.length === 1/);
  assert.doesNotMatch(clicked, /keyPress|New chat|新对话|Ctrl\\\+N|⌘N/);
});

test("discovery does not use the conversation directory as an availability probe", () => {
  const source = require("node:fs").readFileSync(require.resolve("../index.js"), "utf8");
  const discoveryBody = source.slice(source.indexOf("async function discovery()"), source.indexOf("function toSession("));
  assert.doesNotMatch(discoveryBody, /readThreadsFromState/);
  assert.doesNotMatch(discoveryBody, /thread_count/);
});

test("new conversation creation never reuses the previously foreground thread", () => {
  assert.equal(__test.isNewDirectThreadID(THREAD_ID, THREAD_ID), false);
  assert.equal(
    __test.isNewDirectThreadID("22222222-2222-4222-8222-222222222222", THREAD_ID),
    true,
  );
  assert.equal(__test.isNewDirectThreadID("not-a-thread", THREAD_ID), false);
});

test("new conversation does not treat an anonymous draft as a created native thread", () => {
  assert.equal(__test.isNewDirectThreadID("", THREAD_ID), false);
  assert.equal(__test.isNewDirectThreadID("", ""), false);
});

test("start-session thread resolution accepts only the new desktop foreground id", async () => {
  const resolved = await __test.resolveStartedThreadIDAfterSend({
    previousThreadID: THREAD_ID,
    waitForDirect: async (previousThreadID) => {
      assert.equal(previousThreadID, THREAD_ID);
      return "22222222-2222-4222-8222-222222222222";
    },
  });

  assert.equal(resolved, "22222222-2222-4222-8222-222222222222");
});

test("new conversation waits for a native id only after its first message is sent", () => {
  const source = require("node:fs").readFileSync(require.resolve("../index.js"), "utf8");
  const startBody = source.slice(source.indexOf("async function startSessionWithMessage"), source.indexOf("async function send("));
  const sendIndex = startBody.indexOf("await controller.sendMessage");
  const resolveIndex = startBody.lastIndexOf("resolveStartedThreadIDAfterSend");
  assert.ok(sendIndex >= 0);
  assert.ok(resolveIndex > sendIndex);
});

test("desktop watcher detail carries the readable desktop title but never a native id", () => {
  const detail = __test.detailSnapshotFromDesktopWatch(THREAD_ID, {
    thread: { title: "修复详情标题" },
    runtime: {},
    composer: {},
  });
  assert.equal(detail.title, "修复详情标题");
  assert.equal(__test.desktopConversationTitle(THREAD_ID, { thread: { title: THREAD_ID } }), "");
});

test("desktop watcher exposes foreground model and reasoning as read-only values", () => {
  const detail = __test.detailSnapshotFromDesktopWatch(THREAD_ID, {
    runtime: {},
    composer: {
      model: { id: "gpt-5.6", displayName: "GPT-5.6", available: true },
      reasoning: { key: "high", displayName: "High", available: true },
    },
  });
  assert.equal(detail.current_model.id, "gpt-5.6");
  assert.equal(detail.current_reasoning.key, "high");
  assert.deepEqual(detail.model_options, []);
  assert.deepEqual(detail.reasoning_options, []);
});

test("interrupt uses the Composer Fiber runtime action and never sends a global shortcut", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let clickScript = "";
  let keyPresses = 0;
  controller.ensureReady = async () => {};
  controller.evaluate = async (source) => {
    clickScript = source;
    return { ok: true };
  };
  controller.waitFor = async () => {
    throw new Error("interrupt should not wait for the desktop render to settle");
  };
  controller.keyPress = async () => {
    keyPresses += 1;
  };

  await controller.interrupt();

  assert.match(clickScript, /data-codex-composer/);
  assert.match(clickScript, /submitButtonMode/);
  assert.match(clickScript, /isResponseInProgress/);
  assert.match(clickScript, /facts\.mode !== 'stop'/);
  assert.doesNotMatch(clickScript, /停止\|Stop|发送\|Send|排队\|队列\|Queue/);
  assert.match(clickScript, /pointerdown/);
  assert.equal(keyPresses, 0);
});

test("interrupt fails explicitly when Codex has no visible Stop control", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.ensureReady = async () => {};
  controller.evaluate = async () => ({ ok: false, reason: "interrupt_control_unavailable" });
  controller.waitFor = async () => {
    throw new Error("must not wait after a failed click");
  };

  await assert.rejects(() => controller.interrupt(), /interrupt_control_unavailable/);
});

test("desktop watcher emits the Plugin Bridge event envelope", () => {
  assert.equal(__test.pluginEventName, "plugin.event");
});

test("history keeps adjacent assistant messages with distinct IDs separate", () => {
  const messages = __test.historyMessagesForDisplay([
    { ID: "assistant-1", Role: "assistant", Content: "Earlier response" },
    { ID: "assistant-2", Role: "assistant", Content: "Final summary" },
  ]);

  assert.deepEqual(messages.map((item) => item.ID), ["assistant-1", "assistant-2"]);
  assert.deepEqual(messages.map((item) => item.Content), ["Earlier response", "Final summary"]);
});

test("history retains Codex commentary-phase progress messages", () => {
  assert.equal(__test.isDesktopVisibleAssistantMessage({ phase: "commentary" }), true);
  assert.equal(__test.isDesktopVisibleAssistantMessage({ phase: "final_answer" }), true);
  assert.equal(__test.isDesktopVisibleAssistantMessage({}), true);
});
