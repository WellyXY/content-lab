import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { insertRecreationSql, recreationKey, rowToRecreation, RECREATIONS_PER_POST } from "../lib/server/recreations.ts";

test("recreation media keys accept only the two known files", () => {
  assert.equal(recreationKey("rc_1", "video.mp4"), "recreations/rc_1/video.mp4");
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
});

test("the cap is enforced inside one statement, even for back-to-back requests", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE recreations (id TEXT PRIMARY KEY, post_id TEXT, status TEXT, notes_json TEXT, video_url TEXT, cover_url TEXT, error TEXT, counts INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)");
  const insert = db.prepare(insertRecreationSql);
  const results = ["a", "b", "c"].map((id) => insert.run(id, "p1", "t", "t", "p1", 2).changes);
  assert.deepEqual(results, [1, 1, 0]);
  db.prepare("UPDATE recreations SET counts = 0 WHERE id = 'a'").run();
  assert.equal(insert.run("d", "p1", "t", "t", "p1", 2).changes, 1);
});
