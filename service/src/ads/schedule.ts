/** Taipei is UTC+8; the daily ads refresh runs from 10:30 local time, once per local date. */
const OFFSET_MS = 8 * 3_600_000;
const START_MINUTES = 10 * 60 + 30;

/** The idempotency key of today's ads sync once it is due, otherwise null. */
export function adsSyncDue(now: Date): string | null {
  const local = new Date(now.getTime() + OFFSET_MS);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minutes >= START_MINUTES ? `ads_sync:${local.toISOString().slice(0, 10)}` : null;
}
