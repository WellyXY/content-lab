import assert from "node:assert/strict";
import test from "node:test";
import { computeCalibration } from "../lib/calibration.ts";

const row = (id, registrationPotential, cpr, extra = {}) => ({ id, market: "VN", postType: "video", creatorHandle: null, spend: 100, registrations: 100 / cpr, registrationPotential, creativeScore: 5, ...extra });

test("a perfect ranking within a cohort correlates fully and has no surprises", () => {
  const result = computeCalibration([row("a", 9, 0.4), row("b", 7, 0.5), row("c", 5, 0.6), row("d", 3, 0.7), row("e", 1, 0.8)]);
  assert.equal(result.graded, 5);
  assert.equal(result.cohorts[0].rho, 1);
  assert.equal(result.surprises.length, 0);
});

test("thin evidence waits, cohorts stay within market and format, and big misses are surprises", () => {
  const result = computeCalibration([
    row("a", 9, 0.9), row("b", 7, 0.5), row("c", 5, 0.6), row("d", 3, 0.7), row("e", 1, 0.3),
    row("thin", 8, 0.5, { spend: 20 }), row("photo", 8, 0.5, { postType: "photo" }), row("unscored", null, 0.5),
  ]);
  assert.equal(result.graded, 5);
  assert.equal(result.awaitingEvidence, 2);
  assert.deepEqual(result.surprises.map((post) => [post.id, post.surprise]).sort(), [["a", "overrated"], ["e", "underrated"]]);
  assert.ok(result.cohorts[0].rho < 0);
});
