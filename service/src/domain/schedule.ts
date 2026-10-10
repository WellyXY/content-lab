const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type TrackingState = "active" | "slow" | "daily" | "stopped";

export interface CadenceInput {
  publishedAtMs: number;
  nowMs: number;
  views: number;
  recentThreeHourDelta: number;
  /** Growth since the capture about a day ago: lets an older post that takes off again be watched hourly. */
  dayGrowth?: { delta: number; base: number } | null;
}

/** An older post counts as re-ignited when its last day grew by this much or this share. */
export const REIGNITE_DAY_VIEWS = 50_000;
export const REIGNITE_DAY_RATIO = 0.3;

const reignited = (growth: CadenceInput["dayGrowth"]): boolean => !!growth
  && (growth.delta >= REIGNITE_DAY_VIEWS || (growth.base > 0 && growth.delta / growth.base >= REIGNITE_DAY_RATIO));

export function cadenceForPost(input: CadenceInput): { state: TrackingState; intervalMs: number | null } {
  const age = Math.max(0, input.nowMs - input.publishedAtMs);
  if (age <= 3 * DAY) return { state: "active", intervalMs: HOUR };
  if (age <= 7 * DAY) {
    const ratio = input.views > 0 ? input.recentThreeHourDelta / input.views : 0;
    return ratio >= 0.05 ? { state: "active", intervalMs: HOUR } : { state: "slow", intervalMs: 3 * HOUR };
  }
  if (age <= 30 * DAY) return reignited(input.dayGrowth) ? { state: "active", intervalMs: HOUR } : { state: "daily", intervalMs: DAY };
  return { state: "stopped", intervalMs: null };
}

export function nextCaptureAt(input: CadenceInput): { state: TrackingState; nextCaptureAt: string | null } {
  const cadence = cadenceForPost(input);
  return {
    state: cadence.state,
    nextCaptureAt: cadence.intervalMs === null ? null : new Date(input.nowMs + cadence.intervalMs).toISOString(),
  };
}
