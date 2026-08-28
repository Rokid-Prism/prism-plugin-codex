"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { __test } = require("../index.js");

test("rate-limit projections identify five-hour and weekly windows in either slot", () => {
  // The seven-day window can surface as `secondary` ...
  const secondaryForm = __test.weeklyRateLimit({
    rateLimitsByLimitId: {
      codex: {
        secondary: { usedPercent: 37.6, windowDurationMins: 10080, resetsAt: 1_700_000_000 },
        primary: { usedPercent: 3, windowDurationMins: 300 },
      },
    },
  });
  assert.deepEqual(secondaryForm, { used_percent: 38, window_minutes: 10080, resets_at: 1_700_000_000_000 });
  // ... or as `primary` (secondary=null), which is what the live desktop account returns.
  const primaryForm = __test.weeklyRateLimit({
    rateLimits: { primary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: 1_786_165_715 }, secondary: null },
  });
  assert.deepEqual(primaryForm, { used_percent: 91, window_minutes: 10080, resets_at: 1_786_165_715_000 });
  assert.deepEqual(__test.fiveHourRateLimit({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 37.6, windowDurationMins: 300, resetsAt: 1_700_100_000 },
      },
    },
  }), { used_percent: 38, window_minutes: 300, resets_at: 1_700_100_000_000 });
  assert.deepEqual(__test.fiveHourRateLimit({
    rateLimits: { primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_786_165_715 }, secondary: null },
  }), { used_percent: 8, window_minutes: 300, resets_at: 1_786_165_715_000 });
  assert.equal(__test.weeklyRateLimit({ rateLimits: { secondary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1 } } }), null);
  assert.equal(__test.weeklyRateLimit({ rateLimits: { primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1 } } }), null);
  assert.equal(__test.fiveHourRateLimit({ rateLimits: { secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1 } } }), null);
});

test("sparse rate-limit updates retain the last observed window fields", () => {
  const previous = { rateLimits: { secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2_000 } } };
  const merged = __test.mergeSparseObject(previous, { rateLimits: { secondary: { usedPercent: 21 } } });
  assert.deepEqual(__test.weeklyRateLimit(merged), { used_percent: 21, window_minutes: 10080, resets_at: 2_000_000 });

  const fiveHourPrevious = { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000 } } };
  const fiveHourMerged = __test.mergeSparseObject(fiveHourPrevious, { rateLimits: { primary: { usedPercent: 21 } } });
  assert.deepEqual(__test.fiveHourRateLimit(fiveHourMerged), { used_percent: 21, window_minutes: 300, resets_at: 2_000_000 });
});

test("account summary is omitted when App Server data is incomplete", () => {
  assert.deepEqual(__test.accountUsageSummary({ summary: { lifetimeTokens: 10, peakDailyTokens: 5, currentStreakDays: 2, longestStreakDays: 3 } }), {
    lifetime_tokens: 10, peak_daily_tokens: 5, current_streak_days: 2, longest_streak_days: 3,
  });
  assert.equal(__test.accountUsageSummary({ summary: { lifetimeTokens: 10 } }), null);
});
