const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CdpPageClient } = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
const { CodexDesktopController } = require("../codex_cdp.js");
const { __test } = require("../index.js");

class FakeWebSocket {
  static instances = [];

  constructor() {
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send() {}

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

test("CDP command timeout closes and clears the active connection", async () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const client = new CdpPageClient({ commandTimeoutMs: 15 });
    await client.openWebSocket("ws://test");

    await assert.rejects(client.send("Runtime.evaluate"), /timed out after 15ms/);
    assert.equal(client.ws, null);
    assert.equal(client.connected, false);
    assert.equal(client.pending.size, 0);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("late close from a replaced socket does not affect the active socket", async () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const client = new CdpPageClient({ commandTimeoutMs: 100 });
    await client.openWebSocket("ws://first");
    const first = client.ws;
    client.connected = true;

    await client.openWebSocket("ws://second");
    const second = client.ws;
    client.connected = true;
    first.close();

    assert.equal(client.ws, second);
    assert.equal(client.connected, true);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("ordinary CDP probing never launches a closed Codex Desktop", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-closed-"));
  const controller = new CodexDesktopController({ userDataDir: profile });
  let launched = false;
  controller.launchManagedTarget = async () => {
    launched = true;
    throw new Error("must not launch");
  };
  try {
    await assert.rejects(controller.resolvePageTarget(), /Codex Desktop 未运行/);
    assert.equal(launched, false);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("CDP evaluate surfaces page exceptions instead of returning an empty result", async () => {
  const client = new CdpPageClient();
  client.send = async () => ({
    result: { type: "undefined" },
    exceptionDetails: {
      text: "Uncaught SyntaxError",
      exception: { description: "SyntaxError: unexpected token" },
    },
  });

  await assert.rejects(client.evaluate("(() => { broken })()"), /CDP Runtime\.evaluate failed: SyntaxError: unexpected token/);
});

test("composer submission reports a real confirmation surface instead of timing out", async () => {
  const surface = {
    surface_id: "desktop-surface:confirm",
    kind: "dialog",
    title: "Confirm queued message",
    description: "Discard the queued message before sending the new message?",
    inputs: [],
    actions: [{ action_id: "desktop-surface:confirm:send", label: "Send", available: true, requires_input: false }],
  };
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async () => ({
    composerText: "keep this draft",
    attachments: 0,
    running: false,
    error: "",
  });
  controller.readInteractiveSurface = async () => surface;

  const result = await controller.waitForComposerSubmission(20);
  assert.deepEqual(result, { outcome: "interactive_surface_opened", surface });
  assert.equal(result.surface.description, "Discard the queued message before sending the new message?");
});

test("interactive surface keeps the raw DOM target after desktop-only actions are filtered", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  const rawSurface = {
    role: "dialog",
    id: "permission-confirm",
    ariaLabel: "",
    title: "",
    description: "Full access can modify files outside the workspace.",
    inputs: [],
    actions: [
      { index: 0, label: "Learn more", available: true, requiresInput: false, remoteAvailable: false },
      { index: 1, label: "Cancel", available: true, requiresInput: false, remoteAvailable: true },
      { index: 2, label: "Confirm", available: true, requiresInput: false, remoteAvailable: true },
    ],
  };
  let reads = 0;
  controller.readInteractiveSurfaceRaw = async () => {
    reads += 1;
    return reads === 1 ? rawSurface : null;
  };
  let clickScript = "";
  controller.evaluate = async (source) => {
    clickScript = source;
    return true;
  };

  const surface = controller.publicInteractiveSurface(rawSurface);
  assert.equal(surface.title, "");
  assert.equal(surface.description, "Full access can modify files outside the workspace.");
  assert.deepEqual(surface.actions.map((action) => action.label), ["Cancel", "Confirm"]);

  await controller.applyInteractiveSurface(surface.surface_id, surface.actions[0].action_id);

  assert.match(clickScript, /actions\[1\]/);
  assert.doesNotMatch(clickScript, /actions\[0\]/);
  assert.match(clickScript, /PointerEvent\('pointerdown'/);
  assert.match(clickScript, /MouseEvent\('click'/);
});

test("interactive surface uses the native setter before submitting controlled input", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  const rawSurface = {
    role: "dialog",
    id: "rename-thread",
    ariaLabel: "",
    title: "",
    description: "",
    inputs: [{ index: 0, tag: "INPUT", type: "text" }],
    actions: [{ index: 0, label: "Save", available: true, requiresInput: false, acceptsInput: true, remoteAvailable: true }],
  };
  let reads = 0;
  controller.readInteractiveSurfaceRaw = async () => {
    reads += 1;
    return reads === 1 ? rawSurface : null;
  };
  const scripts = [];
  controller.evaluate = async (source) => {
    scripts.push(source);
    return true;
  };

  const surface = controller.publicInteractiveSurface(rawSurface);
  await controller.applyInteractiveSurface(surface.surface_id, surface.actions[0].action_id, "New title");

  assert.match(scripts[0], /Object\.getOwnPropertyDescriptor\(prototype, 'value'\)/);
  assert.match(scripts[0], /HTMLInputElement\.prototype/);
  assert.match(scripts[1], /actions\[0\]/);
});

test("goal editing is rejected without mutating Codex's separate goal workspace", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  await assert.rejects(
    () => controller.updateGoal("After"),
    /control_unsupported: Codex goal editing is not safely available remotely/
  );
  const source = CodexDesktopController.prototype.updateGoal.toString();
  assert.doesNotMatch(source, /goal\.clear/);
  assert.doesNotMatch(source, /setGoal\(/);
  assert.doesNotMatch(source, /prismGoalControl\('edit'\)/);
});

test("composer primary action is uniquely scoped to its footer and uses a real CDP click", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let availabilityScript = "";
  let clickScript = "";
  let evaluations = 0;
  controller.evaluate = async (source) => {
    evaluations += 1;
    if (evaluations === 1) {
      return {
        usable: true,
        enabled: true,
        submit_disabled: false,
        response_in_progress: false,
        mode: "submit",
        has_message_content: true,
        interaction_blocked: false,
      };
    }
    availabilityScript = source;
    return true;
  };
  controller.clickElement = async (source) => {
    clickScript = source;
  };

  await controller.clickComposerPrimaryButton();

  assert.match(availabilityScript, /data-composer-navigation-target/);
  assert.match(availabilityScript, /aria-haspopup/);
  assert.match(availabilityScript, /hasComposerPrimaryButtonContract/);
  assert.match(clickScript, /data-codex-composer/);
  assert.match(clickScript, /actionCandidates\.length === 1/);
  assert.match(clickScript, /hasComposerPrimaryButtonContract/);
  assert.doesNotMatch(clickScript, /发送|Send|size-token-button-composer|dispatchEvent/);
});

test("composer send waits for the Fiber submit mode instead of any footer button", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let evaluated = "";
  controller.evaluate = async (source) => {
    evaluated = source;
    return {
      usable: true,
      enabled: true,
      submit_disabled: false,
      interaction_blocked: false,
      mode: "submit",
      has_message_content: true,
    };
  };

  const result = await controller.waitForComposerSendReady();

  assert.equal(result.mode, "submit");
  assert.equal(result.has_message_content, true);
  assert.equal(result.submission_kind, "send");
  assert.match(evaluated, /prismComposerPrimaryActionFacts/);
  assert.doesNotMatch(evaluated, /composerText/);
});

test("composer primary action requires a real editable input, not a composer-shaped onboarding form", () => {
  const cdpSource = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");

  assert.match(cdpSource, /composer_input_unavailable/);
  assert.match(cdpSource, /textarea, input:not\(\[type="hidden"\]\), \[contenteditable="true"\]/);
  assert.match(cdpSource, /editableSurfaces\.length === 0/);
  assert.match(cdpSource, /composer\.matches\('textarea, input:not\(\[type="hidden"\]\), \[contenteditable="true"\]'\)/);
});

test("composer submission uses the same root as native text insertion", () => {
  const cdpSource = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");

  assert.match(cdpSource, /function composerContainerElementExpression\(\)/);
  assert.match(cdpSource, /const root = document\.querySelector\('\[data-codex-composer-root\]'\)/);
  assert.match(cdpSource, /const composer = \$\{composerContainerElementExpression\(\)\};/);
});

test("running queue Composer accepts the native Stop-mode queue submit", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async () => ({
    usable: true,
    enabled: true,
    submit_disabled: false,
    interaction_blocked: false,
    mode: "stop",
    response_in_progress: true,
    queueing_enabled: true,
    has_message_content: true,
  });

  const result = await controller.waitForComposerSendReady();

  assert.equal(result.mode, "stop");
  assert.equal(result.submission_kind, "queue");
});

test("running guide Composer accepts the native Stop-mode guide submit", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async () => ({
    usable: true,
    enabled: true,
    submit_disabled: false,
    interaction_blocked: false,
    mode: "stop",
    response_in_progress: true,
    queueing_enabled: false,
    has_message_content: true,
  });

  const result = await controller.waitForComposerSendReady();

  assert.equal(result.mode, "stop");
  assert.equal(result.submission_kind, "guide");
});

test("composer readiness timeout reports safe Fiber facts without user text", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async () => ({
    usable: true,
    enabled: true,
    submit_disabled: false,
    interaction_blocked: false,
    mode: "stop",
    response_in_progress: true,
    has_message_content: true,
  });

  await assert.rejects(
    controller.waitForComposerSendReady(1),
    /queue_unavailable: native composer did not become submit-ready/,
  );
});

test("running guide Composer clicks its unique primary action without a localized target", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let clicked = false;
  controller.evaluate = async () => ({
    usable: true,
    enabled: true,
    submit_disabled: false,
    response_in_progress: true,
    queueing_enabled: false,
    mode: "stop",
    has_message_content: true,
    interaction_blocked: false,
  });
  controller.clickElement = async () => {
    clicked = true;
  };

  const result = await controller.clickComposerPrimaryButton("guide");

  assert.deepEqual(result, { submission_kind: "guide" });
  assert.equal(clicked, true);
});

test("running queue Composer clicks its unique primary action without a localized target", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let clicked = false;
  let evaluations = 0;
  controller.evaluate = async () => {
    evaluations += 1;
    if (evaluations === 1) {
      return {
        usable: true,
        enabled: true,
        submit_disabled: false,
        response_in_progress: true,
        queueing_enabled: true,
        mode: "stop",
        has_message_content: true,
        interaction_blocked: false,
      };
    }
    return true;
  };
  controller.clickElement = async (source) => {
    clicked = true;
    assert.match(source, /actionCandidates\.length === 1/);
    assert.doesNotMatch(source, /加入队列|排队/);
  };

  const result = await controller.clickComposerPrimaryButton("queue");

  assert.deepEqual(result, { submission_kind: "queue" });
  assert.equal(clicked, true);
});

test("queue send is confirmed only after a fresh native queue item appears", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let reads = 0;
  controller.queuedMessageState = async () => {
    reads += 1;
    return reads === 1
      ? { items: [{ id: "existing" }], actions: [] }
      : { items: [{ id: "existing" }, { id: "native-message-id" }], actions: [] };
  };
  controller.readInteractiveSurface = async () => null;

  const result = await controller.waitForQueuedMessageSubmission(new Set(["existing"]), 1000);

  assert.deepEqual(result, { outcome: "queue_visible", queue_item_id: "native-message-id" });
});

test("queue send remains accepted when Codex mounts the native queue row late", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.queuedMessageState = async () => null;
  controller.readInteractiveSurface = async () => null;

  const result = await controller.waitForQueuedMessageSubmission(new Set(), 0);

  assert.deepEqual(result, { outcome: "queue_pending" });
});

test("running composer submits when native text exposes Submit", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let evaluations = 0;
  let clicked = false;
  controller.evaluate = async () => {
    evaluations += 1;
    if (evaluations === 1) {
      return {
        usable: true,
        enabled: true,
        submit_disabled: false,
        response_in_progress: true,
        mode: "submit",
        has_message_content: true,
        interaction_blocked: false,
      };
    }
    return true;
  };
  controller.clickElement = async () => {
    clicked = true;
  };

  await controller.clickComposerPrimaryButton();
  assert.equal(clicked, true);
});

test("composer primary action rejects an ambiguous footer instead of guessing or pressing Enter", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let clicked = false;
  controller.evaluate = async () => false;
  controller.clickElement = async () => {
    clicked = true;
  };

  await assert.rejects(controller.clickComposerPrimaryButton(), /control_target_stale/);
  assert.equal(clicked, false);
});

test("message send propagates a stale primary action without an Enter fallback", async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  let keyPresses = 0;
  controller.setComposerText = async () => {};
  controller.waitForComposerSendReady = async () => ({ submission_kind: "send" });
  controller.clickComposerPrimaryButton = async () => {
    throw new Error("control_target_stale");
  };
  controller.keyPress = async () => {
    keyPresses += 1;
  };

  await assert.rejects(controller.sendCurrentComposer("queued text"), /control_target_stale/);
  assert.equal(keyPresses, 0);
});

test("native attachment injection uses ComposerController handlers without locale matching", () => {
  const cdpSource = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");

  assert.match(cdpSource, /composerController\.pastedFilesHandlers/);
  assert.doesNotMatch(cdpSource, /composerController\.pastedImagesHandlers/);
  assert.match(cdpSource, /handler\(\[file\]\)/);
  assert.match(cdpSource, /function composerAttachmentStateSource/);
  assert.match(cdpSource, /prismComposerAttachmentState/);
  assert.match(cdpSource, /composer-attachment-surface/);
  assert.match(cdpSource, /Object\.defineProperty\(file, 'path'/);
  assert.match(cdpSource, /const handlers = composerController\.pastedFilesHandlers/);
  assert.match(cdpSource, /attachmentStateExpression/);
  assert.doesNotMatch(cdpSource, /new ClipboardEvent\('paste'/);
  assert.doesNotMatch(cdpSource, /\^移除/);
  assert.doesNotMatch(cdpSource, /\^Remove /);
});

test("Codex runtime exposes a queue action only when the Composer Fiber verifies it", () => {
  const cdpSource = fs.readFileSync(path.join(__dirname, "..", "codex_cdp.js"), "utf8");
  const pluginSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const threadID = "11111111-1111-4111-8111-111111111111";
  const defaultQueuePreference = {
    current_thread_id: threadID,
    running: true,
    waiting_approval: false,
    can_queue: true,
    queue_pending: true,
    primary_action: "queue",
  };

  const withoutNativeQueue = __test.runtimeWithLiveQueue(defaultQueuePreference, null);
  const queueRun = __test.controlsRuntimeFromDesktopSnapshot(threadID, withoutNativeQueue);
  assert.deepEqual(
    {
      queue: withoutNativeQueue.queue,
      queue_pending: withoutNativeQueue.queue_pending,
      can_queue: withoutNativeQueue.can_queue,
      primary_action: withoutNativeQueue.primary_action,
    },
    { queue: null, queue_pending: false, can_queue: true, primary_action: "queue" },
  );
  assert.equal(queueRun.status, "running");
  assert.equal(queueRun.primary_action, "queue");
  assert.equal(queueRun.can_queue, true);

  const nativeQueue = { items: [{ id: "native-message-id", content: "queued" }], actions: [] };
  const withNativeQueue = __test.runtimeWithLiveQueue(defaultQueuePreference, nativeQueue);
  const waitingRun = __test.controlsRuntimeFromDesktopSnapshot(threadID, withNativeQueue);
  assert.equal(withNativeQueue.queue, nativeQueue);
  assert.equal(withNativeQueue.queue_pending, true);
  assert.equal(waitingRun.status, "waiting");
  assert.equal(waitingRun.primary_action, "queue");
  assert.equal(waitingRun.can_queue, true);

  assert.equal((cdpSource.match(/const canQueue = Boolean\(/g) || []).length, 2);
  assert.equal((cdpSource.match(/const queuePending = false;/g) || []).length, 2);
  assert.doesNotMatch(cdpSource, /running && primary && primary\.mode === 'submit'\s*\n\s*&& primary\.queueing_enabled/);
  assert.match(cdpSource, /else if \(running\) primaryAction = canQueue \? 'queue'/);
  assert.match(pluginSource, /function runtimeWithLiveQueue\(runtime = null, queue = null\)/);
  assert.match(pluginSource, /Array\.isArray\(runtime\.queue\.items\) && runtime\.queue\.items\.length > 0/);
  assert.match(pluginSource, /runtime\.primary_action === "queue" && runtime\.can_queue === true/);
});
