export const MILESTONES = [100_000, 500_000, 1_000_000, 5_000_000] as const;

export interface AlertCandidate {
  rule: "milestone" | "acceleration" | "surge";
  dedupeKey: string;
  level: number | null;
}

export interface AlertInput {
  postId: string;
  previousViews: number;
  currentViews: number;
  currentDelta: number | null;
  priorSixDeltas: number[];
  day: string;
  /** Views gained over the last day and the day before (null when there is no capture that far back). */
  dayDelta?: number | null;
  prevDayDelta?: number | null;
}

/** A day that gains this many views is a surge on its own; a smaller day must triple the day before. */
export const SURGE_DAY_VIEWS = 50_000;
export const SURGE_MIN_DAY_VIEWS = 10_000;
export const SURGE_DAY_RATIO = 3;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

export function evaluateAlerts(input: AlertInput): AlertCandidate[] {
  const candidates: AlertCandidate[] = MILESTONES
    .filter((level) => input.previousViews < level && input.currentViews >= level)
    .map((level) => ({ rule: "milestone" as const, dedupeKey: `${input.postId}:milestone:${level}`, level }));
  const baseline = median(input.priorSixDeltas);
  if (input.currentDelta !== null && input.currentDelta >= 20_000 && baseline !== null && baseline > 0 && input.currentDelta >= baseline * 3) {
    candidates.push({ rule: "acceleration", dedupeKey: `${input.postId}:accel:${input.day}`, level: null });
  }
  const day = input.dayDelta ?? null;
  const before = input.prevDayDelta ?? null;
  if (day !== null && (day >= SURGE_DAY_VIEWS || (day >= SURGE_MIN_DAY_VIEWS && before !== null && before > 0 && day >= before * SURGE_DAY_RATIO))) {
    candidates.push({ rule: "surge", dedupeKey: `${input.postId}:surge:${input.day}`, level: null });
  }
  return candidates;
}
