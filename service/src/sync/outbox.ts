import { randomUUID } from "node:crypto";

import type { ContentLabDatabase } from "../db/database.js";

export type SyncEventType = "post" | "snapshot" | "features" | "prediction" | "job" | "alert" | "playbook";

export function putSyncEvent(
  db: ContentLabDatabase,
  type: SyncEventType,
  entityKey: string,
  payload: unknown,
  occurredAt = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO sync_outbox(id, type, entity_key, occurred_at, payload_json, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, entity_key) DO UPDATE SET
      id=excluded.id, occurred_at=excluded.occurred_at, payload_json=excluded.payload_json,
      attempts=0, next_attempt_at=excluded.next_attempt_at, last_error=NULL
  `).run(randomUUID(), type, entityKey, occurredAt, JSON.stringify(payload), occurredAt);
}
