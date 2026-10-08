export interface MetricPoint {
  capturedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
}

export interface HourlyRow {
  hourBucket: string;
  viewsCum: number | null;
  viewsDelta: number | null;
  likesDelta: number | null;
  commentsDelta: number | null;
  sharesDelta: number | null;
  savesDelta: number | null;
  coverage: "observed" | "interpolated" | "missing";
}

const HOUR = 3_600_000;
export const hourBucket = (timestamp: string | number): string => {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(time)) throw new Error("Invalid timestamp");
  return new Date(Math.floor(time / HOUR) * HOUR).toISOString();
};

const nonNegativeDelta = (current: number, previous: number): number => Math.max(0, current - previous);

export function deriveHourlyRows(previous: MetricPoint | null, current: MetricPoint): HourlyRow[] {
  const currentBucket = Date.parse(hourBucket(current.capturedAt));
  if (!previous) {
    return [{
      hourBucket: new Date(currentBucket).toISOString(), viewsCum: current.views, viewsDelta: null,
      likesDelta: null, commentsDelta: null, sharesDelta: null, savesDelta: null, coverage: "observed",
    }];
  }
  const previousBucket = Date.parse(hourBucket(previous.capturedAt));
  if (currentBucket < previousBucket) throw new Error("Snapshots must be projected in chronological order");
  const gap = Math.round((currentBucket - previousBucket) / HOUR);
  const rows: HourlyRow[] = [];
  for (let offset = 1; offset < gap; offset += 1) {
    rows.push({
      hourBucket: new Date(previousBucket + offset * HOUR).toISOString(), viewsCum: null, viewsDelta: null,
      likesDelta: null, commentsDelta: null, sharesDelta: null, savesDelta: null, coverage: "missing",
    });
  }
  rows.push({
    hourBucket: new Date(currentBucket).toISOString(),
    viewsCum: current.views,
    viewsDelta: nonNegativeDelta(current.views, previous.views),
    likesDelta: nonNegativeDelta(current.likes, previous.likes),
    commentsDelta: nonNegativeDelta(current.comments, previous.comments),
    sharesDelta: nonNegativeDelta(current.shares, previous.shares),
    savesDelta: current.saves === null || previous.saves === null ? null : nonNegativeDelta(current.saves, previous.saves),
    coverage: gap > 1 ? "interpolated" : "observed",
  });
  return rows;
}
