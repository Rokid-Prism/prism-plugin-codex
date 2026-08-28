const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

test("public control target contains only the opaque option id", () => {
  assert.deepEqual(
    __test.controlTargetForOption({
      id: "codex.model:2c99b2",
      menuIndex: 3,
      menuVerified: true,
    }),
    { option_id: "codex.model:2c99b2" },
  );
});

test("control target must match one verified menu row", () => {
  const option = {
    id: "codex.reasoning:7c2b6f",
    key: "high",
    menuIndex: 2,
    menuVerified: true,
  };
  assert.equal(
    __test.resolveStructuredControlTarget("reasoning.switch", { option_id: option.id }, [option]),
    option,
  );
  assert.throws(
    () => __test.resolveStructuredControlTarget("reasoning.switch", { option_id: option.id }, [{ ...option, menuVerified: false }]),
    /control_target_stale/,
  );
});

test("control confirmation accepts only the exact opaque option id", () => {
  assert.equal(
    __test.sameControlTarget({ id: "codex.permission:a" }, { id: "codex.permission:a" }),
    true,
  );
  assert.equal(
    __test.sameControlTarget({ id: "codex.permission:a", key: "never" }, { id: "codex.permission:b", key: "never" }),
    false,
  );
});

test("composer current state replaces stale menu current flags but retains its opaque id", () => {
  const options = __test.withOptionCurrent([
    { id: "codex.model:sol", key: "sol", current: true, menuVerified: true },
    { id: "codex.model:terra", key: "terra", current: false, menuVerified: true },
  ], { id: "terra", key: "terra", displayName: "5.6 Terra" });

  assert.deepEqual(
    options.filter((option) => option.current).map((option) => option.id),
    ["codex.model:terra"],
  );
});

test("live menu rows retain the desktop's raw labels without local translations", () => {
  const model = __test.liveModelOptionFromRow({ optionId: "codex.model:a", label: "5.6 Sol", index: 0, checked: true });
  const reasoning = __test.liveReasoningOptionFromRow({ optionId: "codex.reasoning:b", label: "Very high", index: 1 });
  const permission = __test.liveApprovalOptionFromRow({ optionId: "codex.permission:c", label: "Full access", index: 2 });

  assert.equal(model.label, "5.6 Sol");
  assert.equal(reasoning.label, "Very high");
  assert.equal(reasoning.key, "Very high");
  assert.equal(permission.label, "Full access");
  assert.equal(permission.key, "Full access");
});

test("a live menu does not append an unverified display value as an option", () => {
  const options = __test.withOptionCurrent([
    { id: "codex.reasoning:a", label: "High", displayName: "High", menuVerified: true },
  ], { id: "desktop-only", label: "Very high", displayName: "Very high" });

  assert.deepEqual(options.map((option) => option.id), ["codex.reasoning:a"]);
});

test("closed dynamic controls publish no menu options", () => {
  assert.deepEqual(
    __test.dynamicInteractiveControl("codex.intelligence:abc", "Model", "5.5", ["model", "reasoning"]),
    {
      control_id: "codex.intelligence:abc",
      display_label: "Model",
      current_value: "5.5",
      menu_available: true,
      semantic_kinds: ["model", "reasoning"],
    },
  );
  assert.equal(__test.dynamicInteractiveControl("", "Model", "5.5"), null);
});

test("only a registered surface or tracked permission confirmation is published", () => {
  const state = {};
  const surface = { surface_id: "desktop-surface:previous" };
  const residualThread = "11111111-1111-4111-8111-111111111111";
  const controlThread = "22222222-2222-4222-8222-222222222222";

  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: true }, residualThread, surface),
    null,
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: false }, residualThread, surface),
    null,
  );
  const desktopPermissionSurface = {
    surface_id: "desktop-surface:permission",
    capability: "permission_confirmation",
  };
  assert.deepEqual(
    __test.interactiveSurfaceForForeground(state, { switched: false }, residualThread, desktopPermissionSurface),
    desktopPermissionSurface,
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(
      state,
      { switched: false },
      residualThread,
      { surface_id: "desktop-surface:unrelated" },
    ),
    null,
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(
      state,
      { switched: false },
      residualThread,
      { surface_id: "desktop-surface:image-preview", capability: "image_preview" },
    ),
    null,
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(
      state,
      { switched: false },
      residualThread,
      { surface_id: "desktop-surface:goal-editor", capability: "goal_editor" },
    ),
    null,
  );
  __test.rememberControlCreatedSurface(controlThread, surface);
  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: false }, controlThread, surface),
    null,
  );
  __test.rememberControlCreatedSurface(controlThread, surface, "queue_send_confirmation");
  assert.deepEqual(
    __test.interactiveSurfaceForForeground(state, { switched: true }, controlThread, surface),
    { ...surface, capability: "queue_send_confirmation" },
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(
      state,
      { switched: true, previousThreadID: controlThread },
      residualThread,
      surface,
    ),
    null,
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: false }, controlThread, surface),
    null,
  );
  __test.rememberControlCreatedSurface(controlThread, surface, "conversation_rename");
  assert.equal(
    __test.interactiveSurfaceForForeground(
      state,
      { switched: false },
      controlThread,
      { ...surface, capability: "queue_send_confirmation" },
    ),
    null,
  );
  __test.rememberControlCreatedSurface(controlThread, surface, "conversation_rename");
  __test.rememberControlCreatedSurface(controlThread, { ...surface, capability: "image_preview" }, "conversation_rename");
  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: false }, controlThread, surface),
    null,
  );
  __test.rememberControlCreatedSurface(controlThread, surface, "conversation_rename");
  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: false }, controlThread, { surface_id: "desktop-surface:other" }),
    null,
  );
  assert.equal(
    __test.interactiveSurfaceForForeground(state, { switched: false }, controlThread, surface),
    null,
  );
});

test("plan mode detail publishes an idempotent boolean target", () => {
  assert.deepEqual(__test.planModeDetailFromRuntime({
    plan_mode: { enabled: true, available: true },
  }), {
    enabled: true,
    available: true,
    actions: [{ id: "plan.set", label: "关闭计划模式", available: true, target: { enabled: false } }],
  });
});

test("goal detail publishes only actions valid for the current lifecycle", () => {
  assert.deepEqual(
    __test.goalDetailFromRuntime({ goal: { status: "paused", objective: "Ship it", available: true } }).actions.map((item) => item.id),
    ["goal.resume", "goal.clear"],
  );
  assert.deepEqual(
    __test.goalDetailFromRuntime({ goal: { status: "none", available: true } }).actions.map((item) => item.id),
    ["goal.set"],
  );
});

test("goal and plan structured targets reject ambiguous input", () => {
  assert.equal(__test.booleanControlTarget({ enabled: false }, "enabled"), false);
  assert.equal(__test.objectiveControlTarget({ objective: "  measurable goal  " }), "measurable goal");
  assert.throws(() => __test.booleanControlTarget({}, "enabled"), /must be boolean/);
  assert.throws(() => __test.objectiveControlTarget({ objective: " " }), /objective is required/);
});
