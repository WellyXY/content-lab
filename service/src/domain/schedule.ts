const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type TrackingState = "active" | "slow" | "daily" | "stopped";

export interface CadenceInput {
  publishedAtMs: number;
  nowMs: number;
  views: number;
  recentThreeHourDelta: number;
}

export function cadenceForPost(input: CadenceInput): { state: TrackingState; intervalMs: number | null } {
  const age = Math.max(0, input.nowMs - input.publishedAtMs);
  if (age <= 3 * DAY) return { state: "active", intervalMs: HOUR };
  if (age <= 7 * DAY) {
    const ratio = input.views > 0 ? input.recentThreeHourDelta / input.views : 0;
    return ratio >= 0.05 ? { state: "active", intervalMs: HOUR } : { state: "slow", intervalMs: 3 * HOUR };
  }
  if (age <= 30 * DAY) return { state: "daily", intervalMs: DAY };
  return { state: "stopped", intervalMs: null };
}

export function nextCaptureAt(input: CadenceInput): { state: TrackingState; nextCaptureAt: string | null } {
  const cadence = cadenceForPost(input);
  return {
    state: cadence.state,
    nextCaptureAt: cadence.intervalMs === null ? null : new Date(input.nowMs + cadence.intervalMs).toISOString(),
  };
}
