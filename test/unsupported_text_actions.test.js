const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pluginRoot = path.resolve(__dirname, "..");
const adapterSource = fs.readFileSync(path.join(pluginRoot, "index.js"), "utf8");
const cdpSource = fs.readFileSync(path.join(pluginRoot, "codex_cdp.js"), "utf8");

test("Codex does not publish localized thread or slash-command controls", () => {
  assert.doesNotMatch(adapterSource, /case "context\.compact"/);
  assert.doesNotMatch(adapterSource, /case "thread\.rename"/);
  assert.doesNotMatch(adapterSource, /case "thread\.pin"/);
  assert.doesNotMatch(adapterSource, /case "thread\.archive"/);
  assert.doesNotMatch(adapterSource, /runCodexThreadCommand|compactCodexContext/);

  assert.doesNotMatch(cdpSource, /async openThreadActionsMenu/);
  assert.doesNotMatch(cdpSource, /async selectMenuItemByText/);
  assert.doesNotMatch(cdpSource, /async clickMenuItemByText/);
  assert.doesNotMatch(cdpSource, /clickMenuItemByText/);
  assert.doesNotMatch(cdpSource, /async clickVisibleButtonByText/);
  assert.doesNotMatch(cdpSource, /async runSlashCommand/);
  assert.doesNotMatch(cdpSource, /async archiveThread|async pinThread|async renameThread/);
  assert.match(adapterSource, /waitForThreadArchived\(threadID\)/);
  assert.match(adapterSource, /metadata: \{ archived: "true"/);
  assert.doesNotMatch(cdpSource, /async openAdvancedModelPicker|async switchReasoningWithAdvancedPanel/);
  assert.doesNotMatch(cdpSource, /async listMatchingMenuItems|async listModelOptions|async listReasoningOptions/);
  assert.doesNotMatch(cdpSource, /async intelligenceCandidatesState|async switchModel|async switchReasoning|async switchPermission/);
  assert.doesNotMatch(cdpSource, /function visibleMenuRowsExpression|async openIntelligenceSubmenu|async selectVisibleMenuItem/);
  assert.doesNotMatch(adapterSource, /async switchCodexGuiModel|async switchCodexReasoningMode|async switchCodexApprovalMode/);
});

test("Codex runtime action and queue identities do not use localized labels", () => {
  const primaryFactsStart = cdpSource.indexOf("function composerPrimaryActionFactsSource()");
  const primaryFactsEnd = cdpSource.indexOf("function composerPrimaryActionRuntimeExpression()", primaryFactsStart);
  const primaryFacts = cdpSource.slice(primaryFactsStart, primaryFactsEnd);
  assert.ok(primaryFactsStart >= 0 && primaryFactsEnd > primaryFactsStart);
  assert.match(primaryFacts, /submitButtonMode/);
  assert.match(primaryFacts, /isResponseInProgress/);
  assert.doesNotMatch(primaryFacts, /停止|发送|排队|队列|\/\^\(Stop\)|\/\^\(Send\)|Queue\|Queued/);

  const queueFingerprintStart = cdpSource.indexOf("const queueActionFingerprint =");
  const queueFingerprintEnd = cdpSource.indexOf("const queueActionDescriptor =", queueFingerprintStart);
  const queueFingerprint = cdpSource.slice(queueFingerprintStart, queueFingerprintEnd);
  assert.ok(queueFingerprintStart >= 0 && queueFingerprintEnd > queueFingerprintStart);
  assert.match(queueFingerprint, /queueActionHandlerSource/);
  assert.doesNotMatch(queueFingerprint, /getAttribute\('aria-label'\)|getAttribute\('title'\)|queueText\(el\)/);
  assert.doesNotMatch(queueFingerprint, /JSON\.stringify\(\{[^}]*label/);

  const submissionStart = cdpSource.indexOf("async waitForComposerSubmission");
  const submissionEnd = cdpSource.indexOf("async attachLocalFile", submissionStart);
  const submission = cdpSource.slice(submissionStart, submissionEnd);
  assert.ok(submissionStart >= 0 && submissionEnd > submissionStart);
  assert.doesNotMatch(submission, /Error submitting message|提交消息失败|Please continue this conversation/);
  assert.doesNotMatch(submission, /pageText|errorMatch/);
});

test("Codex closed intelligence state does not invent menu controls from layout", () => {
  assert.match(cdpSource, /controlId: 'codex\.intelligence'/);
  assert.doesNotMatch(cdpSource, /for \(const candidate of \[intelligence, \.\.\.intelligence\.querySelectorAll\('\*'\)\]\)/);
});

test("Codex intelligence submenu roots use their exact DOM pointer owner", () => {
  const start = cdpSource.indexOf("async openIntelligenceControl(controlID)");
  const end = cdpSource.indexOf("async listIntelligenceControlOptions", start);
  const body = cdpSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /aria-controls/);
  assert.match(body, /dispatchDomPointerClick\(script\)/);
  assert.doesNotMatch(body, /clickElement\(script\)/);
});

test("Codex conversation Header sessions select a safe trigger only on demand", () => {
  const helperStart = cdpSource.indexOf("function conversationHeaderMenuHelpersSource()");
  const helperEnd = cdpSource.indexOf("function macProfileDir()", helperStart);
  const helper = cdpSource.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /prismHeaderTriggers/);
  assert.match(helper, /aria-labelledby/);
  assert.doesNotMatch(helper, /聊天操作|次要操作|Pin|Rename|Archive/);

  const openStart = cdpSource.indexOf("async openConversationHeaderMenu()");
  const openEnd = cdpSource.indexOf("async describeConversationHeaderMenu", openStart);
  const open = cdpSource.slice(openStart, openEnd);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.match(open, /remoteSafeCandidateIDs\.length !== 1/);
  assert.match(open, /dispatchDomPointerClick/);

  const applyStart = cdpSource.indexOf("async applyConversationHeaderMenuSession");
  const applyEnd = cdpSource.indexOf("async withTransparentNativeMenus", applyStart);
  const apply = cdpSource.slice(applyStart, applyEnd);
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  assert.match(apply, /clickDomElement\(target\)/);

  const matcherStart = cdpSource.indexOf("function sameConversationHeaderMenuRows");
  const matcherEnd = cdpSource.indexOf("function sameQueueMenuRows", matcherStart);
  const matcher = cdpSource.slice(matcherStart, matcherEnd);
  assert.ok(matcherStart >= 0 && matcherEnd > matcherStart);
  assert.match(matcher, /optionId/);
  assert.doesNotMatch(matcher, /row\.label|saved\.label/);
});

test("Codex blocks live control when target selection is not confirmed", () => {
  const helperStart = adapterSource.indexOf("async function selectRequiredCodexThread");
  const helperEnd = adapterSource.indexOf("async function activateThread", helperStart);
  const helper = adapterSource.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /selected\.selected !== true/);
  assert.match(helper, /controller\.isThreadSelected\(threadID\)/);
  assert.match(helper, /control_target_stale/);

  for (const functionName of [
    "async function focusTarget",
    "async function controlCodexQueue",
    "async function applyCodexInteractiveSurface",
    "async function resolveApproval",
    "async function describeCodexControls",
    "async function interrupt",
  ]) {
    const start = adapterSource.indexOf(functionName);
    const end = adapterSource.indexOf("\nasync function ", start + functionName.length);
    const body = adapterSource.slice(start, end >= 0 ? end : undefined);
    assert.ok(start >= 0, `missing ${functionName}`);
    assert.match(body, /selectRequiredCodexThread/);
  }
});
