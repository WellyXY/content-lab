/** Format publication metadata in the market's existing fixed UTC offset. */
export function formatPublishedTime(value: string | null, timeZone = "UTC") {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  const offset = /^UTC([+-])(\d{1,2})$/.exec(timeZone);
  const hours = offset ? Number(offset[2]) * (offset[1] === "+" ? 1 : -1) : 0;
  const local = new Date(timestamp + hours * 3_600_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16), timeZone: offset ? timeZone : "UTC" };
}

/** Newest publication first; unknown dates last, without substituting bind time. */
export function comparePublishedNewest(
  a: { id: string; publishedAt: string | null },
  b: { id: string; publishedAt: string | null },
) {
  const aTime = Date.parse(a.publishedAt ?? "");
  const bTime = Date.parse(b.publishedAt ?? "");
  const aKnown = Number.isFinite(aTime);
  const bKnown = Number.isFinite(bTime);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && aTime !== bTime) return bTime - aTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
