/** Post ages (hours) at which early performance is recorded for later calibration. */
export const CHECKPOINT_HOURS = [1, 3, 6, 24, 72] as const;
/** Engagement rates below this many views are noise: a few friends' saves dominate them. */
export const MIN_VIEWS_FOR_RATES = 1_000;

export interface CheckpointSnapshot {
  capturedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
}

export interface Checkpoint {
  hours: number;
  /** recorded: a snapshot close enough to this age exists; missed: the post was not captured near it; pending: not reached yet. */
  status: "recorded" | "missed" | "pending";
  capturedAt: string | null;
  /** The real age of the snapshot used, which can differ slightly from `hours`. */
  ageHours: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  /** Average views per hour since publishing. */
  viewsPerHour: number | null;
  likeRate: number | null;
  commentRate: number | null;
  shareRate: number | null;
  saveRate: number | null;
}

const HOUR = 3_600_000;
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** How far from the target age a snapshot may be: ±50% of the age, at least half an hour. */
export const checkpointTolerance = (hours: number): number => Math.max(0.5, hours * 0.5);

/**
 * Derive every checkpoint from the post's snapshots. The result is a pure
 * function of the data, so it can be recomputed after each capture.
 */
export function deriveCheckpoints(publishedAt: string | null, snapshots: CheckpointSnapshot[], nowMs: number): Checkpoint[] {
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  const empty = (hours: number, status: Checkpoint["status"]): Checkpoint => ({
    hours, status, capturedAt: null, ageHours: null, views: null, likes: null, comments: null, shares: null, saves: null,
    viewsPerHour: null, likeRate: null, commentRate: null, shareRate: null, saveRate: null,
  });
  if (!Number.isFinite(published)) return CHECKPOINT_HOURS.map((hours) => empty(hours, "missed"));
  const aged = snapshots
    .map((snapshot) => ({ snapshot, age: (Date.parse(snapshot.capturedAt) - published) / HOUR }))
    .filter((item) => Number.isFinite(item.age) && item.age > 0);
  const nowAge = (nowMs - published) / HOUR;
  return CHECKPOINT_HOURS.map((hours) => {
    const tolerance = checkpointTolerance(hours);
    const candidates = aged.filter((item) => Math.abs(item.age - hours) <= tolerance);
    if (candidates.length === 0) return empty(hours, nowAge > hours + tolerance ? "missed" : "pending");
    const best = candidates.reduce((closest, item) => (Math.abs(item.age - hours) < Math.abs(closest.age - hours) ? item : closest));
    const { snapshot, age } = best;
    const rate = (count: number | null): number | null => (count === null || snapshot.views < MIN_VIEWS_FOR_RATES ? null : round(count / snapshot.views, 5));
    return {
      hours, status: "recorded", capturedAt: snapshot.capturedAt, ageHours: round(age, 1),
      views: snapshot.views, likes: snapshot.likes, comments: snapshot.comments, shares: snapshot.shares, saves: snapshot.saves,
      viewsPerHour: Math.round(snapshot.views / age),
      likeRate: rate(snapshot.likes), commentRate: rate(snapshot.comments), shareRate: rate(snapshot.shares), saveRate: rate(snapshot.saves),
    };
  });
}
