import assert from "node:assert/strict";
import test from "node:test";
import { formatPublishedTime } from "../lib/published-time.ts";

test("publication dates follow the market offset, including date rollover", () => {
  assert.deepEqual(formatPublishedTime("2026-10-01T18:30:00.000Z", "UTC+7"), {
    date: "2026-10-02", time: "01:30", timeZone: "UTC+7",
  });
  assert.deepEqual(formatPublishedTime("2026-10-01T18:30:00.000Z", "UTC+3"), {
    date: "2026-10-01", time: "21:30", timeZone: "UTC+3",
  });
});

test("missing or invalid publication metadata stays unknown", () => {
  for (const value of [null, "", "invalid"]) assert.equal(formatPublishedTime(value, "UTC+7"), null);
});

test("an unknown market uses explicit UTC, not the viewer's timezone", () => {
  assert.deepEqual(formatPublishedTime("2026-10-01T18:30:00.000Z"), {
    date: "2026-10-01", time: "18:30", timeZone: "UTC",
  });
});
