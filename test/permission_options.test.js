const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

test("permission option preserves the exact menu fingerprint internally", () => {
  const option = __test.liveApprovalOptionFromRow({
    optionId: "codex.permission:4ef1a32b",
    label: "Approve for me",
    index: 1,
    checked: true,
    disabled: false,
  });

  assert.deepEqual(option, {
    id: "codex.permission:4ef1a32b",
    key: "Approve for me",
    value: "Approve for me",
    label: "Approve for me",
    displayName: "Approve for me",
    available: true,
    current: true,
    menuIndex: 1,
    menuVerified: true,
  });
});

test("permission current state only accepts an exact cached row label", () => {
  const rows = [
    __test.liveApprovalOptionFromRow({ optionId: "codex.permission:ask", label: "Ask for approval", index: 0, checked: true }),
    __test.liveApprovalOptionFromRow({ optionId: "codex.permission:full", label: "Full access", index: 1, checked: false }),
  ];

  const selected = __test.withPermissionOptionCurrent(rows, { label: "Full access" });
  assert.deepEqual(selected.map((row) => row.current), [false, true]);

  const unknown = __test.withPermissionOptionCurrent(rows, { label: "Changed elsewhere" });
  assert.deepEqual(unknown.map((row) => row.current), [false, false]);
});

test("menu session rows retain native selected state without inferring it from labels", () => {
  const rows = __test.menuSessionRows([
    { optionId: "native-radio-a", label: "First native option", current: false },
    { optionId: "native-radio-b", label: "Second native option", current: true },
  ]);

  assert.deepEqual(rows.map((row) => row.current), [false, true]);
});
