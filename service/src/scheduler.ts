import type { ContentLabDatabase } from "./db/database.js";
import { enqueueJob } from "./jobs/queue.js";

export interface SchedulerResult {
  duePosts: number;
  queuedJobs: number;
  wokeFromSleep: boolean;
  gapMs: number | null;
}

export function runSchedulerCycle(db: ContentLabDatabase, now = new Date().toISOString()): SchedulerResult {
  const previous = db.prepare("SELECT value FROM scheduler_state WHERE key='last_scan_at'").get() as { value: string } | undefined;
  const gapMs = previous ? Math.max(0, Date.parse(now) - Date.parse(previous.value)) : null;
  const wokeFromSleep = gapMs !== null && gapMs > 15 * 60_000;
  const due = db.prepare(`
    SELECT id, next_capture_at FROM posts
    WHERE tracking_state != 'stopped' AND next_capture_at IS NOT NULL AND next_capture_at <= ?
    ORDER BY next_capture_at
  `).all(now) as Array<{ id: string; next_capture_at: string }>;
  let queuedJobs = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const post of due) {
      const before = (db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;
      enqueueJob(db, {
        kind: "capture", payload: { postId: post.id, wokeFromSleep },
        runAt: now, idempotencyKey: `capture:${post.id}:${post.next_capture_at}`,
      });
      const after = (db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;
      if (after > before) queuedJobs += 1;
    }
    db.prepare(`
      INSERT INTO scheduler_state(key, value, updated_at) VALUES ('last_scan_at', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(now, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { duePosts: due.length, queuedJobs, wokeFromSleep, gapMs };
}
