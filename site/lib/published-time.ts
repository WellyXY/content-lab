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
