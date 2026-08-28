const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { CodexDesktopController, __test } = require("../codex_cdp.js");

const PLAN_ICON_PATH = "M8 3.52051C9.07134 test-path";

function visibleElement(extra = {}) {
  return {
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
    ...extra,
  };
}

function planButton({ slashMenuRow = false } = {}) {
  const button = visibleElement({
    querySelector: (selector) => selector === "svg path"
      ? { getAttribute: (name) => name === "d" ? PLAN_ICON_PATH : "" }
      : null,
  });
  button.closest = (selector) => slashMenuRow && selector.includes("data-list-navigation-item")
    ? button
    : null;
  return button;
}

function goalPathElement(path) {
  return visibleElement({
    querySelector: (selector) => selector === "path"
      ? { getAttribute: (name) => name === "d" ? path : "" }
      : null,
  });
}

function goalButton(path = "", children = []) {
  return visibleElement({
    tagName: "BUTTON",
    children,
    querySelector: (selector) => selector === "svg path" && path
      ? { getAttribute: (name) => name === "d" ? path : "" }
      : null,
  });
}

function goalSpan(text, children = []) {
  return visibleElement({
    tagName: "SPAN",
    innerText: text,
    textContent: text,
    children,
    childNodes: [{ nodeType: 3, nodeValue: text }],
  });
}

function activeGoalCard(objective = "Ship release", { includeEdit = true } = {}) {
  const goalIcon = goalPathElement("M9.96861 1.91681 current-goal");
  const summary = goalButton("", [
    goalSpan("Running"),
    { ...goalSpan(`${objective} dot`, [goalSpan(" dot ")]), childNodes: [{ nodeType: 3, nodeValue: objective }] },
    goalSpan("2m"),
  ]);
  const clear = goalButton("M10.6299 1.33496 clear");
  const pause = goalButton("M10.625 7.91667 pause");
  const edit = goalButton("M4.33496 11 edit");
  const controls = [summary, clear, pause];
  if (includeEdit) controls.push(edit);
  const row = visibleElement({
    tagName: "DIV",
    children: [],
    querySelectorAll: (selector) => selector === "button" ? controls : [],
  });
  const leading = visibleElement({ tagName: "DIV", parentElement: row, querySelectorAll: () => [] });
  goalIcon.parentElement = leading;
  return { goalIcon, row };
}

function readGoalPlanState(buttons, { goalIcon = null } = {}) {
  const composer = visibleElement({
    querySelectorAll: (selector) => selector === "button" ? buttons : [],
  });
  const document = {
    querySelector: (selector) => selector === "[data-codex-composer-root]" ? composer : null,
    querySelectorAll: (selector) => selector === "svg" && goalIcon ? [goalIcon] : [],
  };
  return vm.runInNewContext(
    `(() => { ${__test.goalPlanDOMHelpersSource()} return prismGoalPlanState(); })()`,
    { document },
  );
}

test("slash command plan row is not an active plan indicator", () => {
  const state = readGoalPlanState([planButton({ slashMenuRow: true })]);

  assert.equal(state.plan_mode.available, true);
  assert.equal(state.plan_mode.enabled, false);
});

test("persistent composer plan control is an active plan indicator", () => {
  const state = readGoalPlanState([planButton()]);

  assert.equal(state.plan_mode.available, true);
  assert.equal(state.plan_mode.enabled, true);
});

test("closing an active plan uses the persistent Composer toggle", () => {
  const source = CodexDesktopController.prototype.setPlanMode.toString();

  assert.match(source, /if \(!desired\)/);
  assert.match(source, /prismPlanIndicator\(\)/);
  assert.doesNotMatch(source, /if \(!desired\)[\s\S]{0,500}openSlashCommand/);
});

test("current Goal card reads the direct summary button and new edit icon", () => {
  const state = readGoalPlanState([], activeGoalCard("Ship release"));

  assert.equal(state.goal.status, "running");
  assert.equal(state.goal.objective, "Ship release");
  assert.equal(state.goal.available, true);
});

test("compact Goal card remains running when the Desktop defers its Edit affordance", () => {
  const state = readGoalPlanState([], activeGoalCard("Keep release moving", { includeEdit: false }));

  assert.equal(state.goal.status, "running");
  assert.equal(state.goal.objective, "Keep release moving");
  assert.equal(state.goal.actions.edit, false);
  assert.equal(state.goal.actions.pause, true);
  assert.equal(state.goal.actions.clear, true);
});

test("slash Goal command icon without lifecycle actions is not an active Goal", () => {
  const slashGoalIcon = goalPathElement("M9.96861 1.91681 slash-command");
  slashGoalIcon.parentElement = visibleElement({ tagName: "DIV", querySelectorAll: () => [] });

  const state = readGoalPlanState([], { goalIcon: slashGoalIcon });

  assert.equal(state.goal.status, "none");
  assert.equal(state.goal.objective, "");
  assert.equal(state.goal.available, true);
});

test("Goal submission targets only the unique Goal action inside the composer", () => {
  const expression = __test.goalComposerSubmitElementExpression();

  assert.match(expression, /data-codex-composer-root/);
  assert.match(expression, /submitButtonMode/);
  assert.match(expression, /isResponseInProgress/);
  assert.match(expression, /isQueueingEnabled/);
  assert.match(expression, /candidates\.length === 1/);
  assert.doesNotMatch(expression, /明确目标|Set Goal|sendCurrentComposer|GOAL_ICON_PREFIX/);
});

test("Goal controls focus the unique editable composer child, not only the legacy composer attribute", () => {
  const expression = __test.composerEditableElementExpression();

  assert.match(expression, /data-codex-composer-root/);
  assert.match(expression, /\[contenteditable="true"\]/);
  assert.match(expression, /editableCandidates\.length === 1/);
  assert.match(expression, /legacyCandidates\.length === 1/);
  assert.doesNotMatch(expression, /document\.querySelector\('\[data-codex-composer\]'\)/);
});
