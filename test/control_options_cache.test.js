const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

test("verified menu targets change the watcher control signature", () => {
  const labelsOnly = [{ id: "gpt-5.4", available: true }];
  const executable = [{ id: "gpt-5.4", available: true, menuIndex: 2, menuVerified: true }];

  assert.notEqual(
    __test.controlOptionsSignature(labelsOnly),
    __test.controlOptionsSignature(executable),
  );
});

test("fiber label candidates cannot overwrite verified menu targets", () => {
  const structured = [{ id: "gpt-5.4", menuIndex: 2, menuVerified: true }];
  const labelsOnly = [{ id: "gpt-5.4", source: "desktop-state" }];

  assert.deepEqual(
    __test.preserveStructuredControlOptions(structured, labelsOnly),
    structured,
  );
});
