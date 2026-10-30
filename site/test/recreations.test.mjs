import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ACTIVE_RECREATIONS_LIMIT, insertRecreationSql, isCrossSiteRequest, recreationKey, rowToRecreation, RECREATIONS_PER_POST } from "../lib/server/recreations.ts";

test("recreation media keys accept only the video, its cover and carousel copy images", () => {
  assert.equal(recreationKey("rc_1", "video.mp4"), "recreations/rc_1/video.mp4");
  assert.equal(recreationKey("rc_1", "img-03-2.jpg"), "recreations/rc_1/img-03-2.jpg");
  assert.equal(recreationKey("rc_1", "img-3-2.jpg"), null);
  assert.equal(recreationKey("rc_1", "cover.jpg"), "recreations/rc_1/cover.jpg");
  assert.equal(recreationKey("rc_1", "../x.mp4"), null);
  assert.equal(recreationKey("../rc", "video.mp4"), null);
  assert.equal(RECREATIONS_PER_POST, 2);
});

test("recreation rows map notes and tolerate bad JSON", () => {
  const row = { id: "r", status: "complete", notes_json: JSON.stringify({ summary_zh: "好", summary_en: "Good", changes: [] }), video_url: "/v", cover_url: "/c", error: null, counts: 0, created_at: "a", updated_at: "b" };
  assert.equal(rowToRecreation(row).notes.summary_en, "Good");
  assert.equal(rowToRecreation(row).counts, 0);
  assert.equal(rowToRecreation({ ...row, notes_json: "{" }).notes, null);
  assert.equal(rowToRecreation(row).kind, "recreate");
  assert.equal(rowToRecreation({ ...row, kind: "copy" }).kind, "copy");
});

test("the cap is enforced inside one statement, even for back-to-back requests", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE recreations (id TEXT PRIMARY KEY, post_id TEXT, status TEXT, notes_json TEXT, video_url TEXT, cover_url TEXT, error TEXT, counts INTEGER DEFAULT 1, kind TEXT, created_at TEXT, updated_at TEXT)");
  const insert = db.prepare(insertRecreationSql);
  const results = ["a", "b", "c"].map((id) => insert.run(id, "p1", "recreate", "t", "t", "p1", "recreate", 2, 5).changes);
  assert.deepEqual(results, [1, 1, 0]);
  db.prepare("UPDATE recreations SET counts = 0 WHERE id = 'a'").run();
  assert.equal(insert.run("d", "p1", "recreate", "t", "t", "p1", "recreate", 2, 5).changes, 1);
  // Copies of a carousel have their own limit.
  assert.equal(insert.run("e", "p1", "copy", "t", "t", "p1", "copy", 2, 5).changes, 1);
});

test("a site-wide limit on queued and running recreations stops a script from sweeping every post", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE recreations (id TEXT PRIMARY KEY, post_id TEXT, status TEXT, notes_json TEXT, video_url TEXT, cover_url TEXT, error TEXT, counts INTEGER DEFAULT 1, kind TEXT, created_at TEXT, updated_at TEXT)");
  const insert = db.prepare(insertRecreationSql);
  const posts = ["p1", "p2", "p3", "p4", "p5", "p6"];
  assert.deepEqual(posts.map((post) => insert.run(`r-${post}`, post, "recreate", "t", "t", post, "recreate", 2, ACTIVE_RECREATIONS_LIMIT).changes), [1, 1, 1, 1, 1, 0]);
  db.prepare("UPDATE recreations SET status = 'complete' WHERE id = 'r-p1'").run();
  assert.equal(insert.run("r-p6", "p6", "recreate", "t", "t", "p6", "recreate", 2, ACTIVE_RECREATIONS_LIMIT).changes, 1);
});

test("cross-site requests are refused, same-origin and header-less ones pass", () => {
  const request = (site) => new Request("https://x.test/api", { method: "POST", headers: site ? { "sec-fetch-site": site } : {} });
  assert.equal(isCrossSiteRequest(request("cross-site")), true);
  assert.equal(isCrossSiteRequest(request("same-origin")), false);
  assert.equal(isCrossSiteRequest(request(null)), false);
});
