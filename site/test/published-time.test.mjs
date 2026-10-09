import assert from "node:assert/strict";
import test from "node:test";
import { comparePublishedNewest, formatPublishedTime } from "../lib/published-time.ts";

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

test("publication sorting uses the actual instant, not display timezone or bind time", () => {
  const posts = [
    { id: "older", publishedAt: "2026-10-08T12:00:00+07:00", boundAt: "2026-10-09T00:00:00Z" },
    { id: "newer", publishedAt: "2026-10-08T09:00:00+03:00", boundAt: "2026-10-08T00:00:00Z" },
  ];
  assert.deepEqual(posts.sort(comparePublishedNewest).map((post) => post.id), ["newer", "older"]);
});

test("unknown dates sort last and equal timestamps have a stable order", () => {
  const posts = [
    { id: "missing", publishedAt: null },
    { id: "b", publishedAt: "2026-10-08T06:00:00Z" },
    { id: "invalid", publishedAt: "invalid" },
    { id: "a", publishedAt: "2026-10-08T13:00:00+07:00" },
  ];
  assert.deepEqual(posts.sort(comparePublishedNewest).map((post) => post.id), ["a", "b", "invalid", "missing"]);
});
