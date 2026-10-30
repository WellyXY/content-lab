/** Taipei is UTC+8; the ads refresh runs every four hours from 10:30 local time (10:30, 14:30, 18:30, 22:30, 02:30, 06:30). */
const OFFSET_MS = 8 * 3_600_000;
const START_MS = (10 * 60 + 30) * 60_000;
const EVERY_MS = 4 * 3_600_000;

/** The idempotency key of the current four-hour ads sync slot; it changes at each slot start, so one sync is queued per slot. */
export function adsSyncDue(now: Date): string {
  // Shift so each day starts at 10:30 local time; the slot counts four-hour steps from there.
  const shifted = new Date(now.getTime() + OFFSET_MS - START_MS);
  const slot = Math.floor((shifted.getTime() % 86_400_000 + 86_400_000) % 86_400_000 / EVERY_MS);
  return `ads_sync:${shifted.toISOString().slice(0, 10)}:${slot}`;
}
