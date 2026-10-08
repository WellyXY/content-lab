export const MILESTONES = [100_000, 500_000, 1_000_000, 5_000_000] as const;

export interface AlertCandidate {
  rule: "milestone" | "acceleration";
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
}

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
  return candidates;
}
