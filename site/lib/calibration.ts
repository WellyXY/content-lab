// Kept free of runtime imports so node:test can load it.

/** Spark Ads evidence thresholds; the same as the worker's (knowledge base calibration protocol, point 3). */
export const EVIDENCE_MIN_SPEND = 50;
export const EVIDENCE_MIN_REGISTRATIONS = 30;
/** A score and its outcome this far apart in percentile rank is a surprise worth a look. */
export const SURPRISE_GAP = 0.5;
/** Rank correlation needs at least this many posts in a cohort. */
export const MIN_COHORT_FOR_RHO = 5;

export type CalibrationRow = {
  id: string; market: string; postType: string; creatorHandle: string | null;
  spend: number | null; registrations: number | null; registrationPotential: number | null; creativeScore: number | null;
};
export type CalibratedPost = CalibrationRow & { cpr: number; predicted: number; actual: number; error: number; surprise: "underrated" | "overrated" | null };
export type Cohort = { market: string; postType: string; posts: CalibratedPost[]; rho: number | null; creativeRho: number | null; meanAbsError: number };
export type Calibration = { cohorts: Cohort[]; graded: number; awaitingEvidence: number; rho: number | null; meanAbsError: number | null; surprises: CalibratedPost[] };

/** Percentile ranks 0..1 (1 = best), ties sharing their average rank. */
function percentiles(values: number[], higherIsBetter: boolean): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => higherIsBetter ? a.value - b.value : b.value - a.value);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end += 1;
    for (let k = start; k <= end; k += 1) ranks[order[k]!.index] = (start + end) / 2;
    start = end + 1;
  }
  return ranks.map((rank) => values.length > 1 ? rank / (values.length - 1) : 0.5);
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/**
 * Compare frozen blind scores with Spark Ads outcomes: within each market and format, how the registration-potential
 * ranking matches the cost-per-registration ranking. Posts without enough evidence wait; they are not failures.
 */
export function computeCalibration(rows: CalibrationRow[]): Calibration {
  const scored = rows.filter((row) => row.registrationPotential !== null);
  const evidence = scored.filter((row) => (row.spend ?? 0) >= EVIDENCE_MIN_SPEND && (row.registrations ?? 0) >= EVIDENCE_MIN_REGISTRATIONS);
  const groups = new Map<string, CalibrationRow[]>();
  for (const row of evidence) groups.set(`${row.market}|${row.postType}`, [...(groups.get(`${row.market}|${row.postType}`) ?? []), row]);
  const cohorts: Cohort[] = [...groups.values()].filter((group) => group.length >= 2).map((group) => {
    const cprs = group.map((row) => row.spend! / row.registrations!);
    const predicted = percentiles(group.map((row) => row.registrationPotential!), true);
    const actual = percentiles(cprs, false);
    const posts = group.map((row, index): CalibratedPost => {
      const error = predicted[index]! - actual[index]!;
      return { ...row, cpr: cprs[index]!, predicted: predicted[index]!, actual: actual[index]!, error, surprise: error >= SURPRISE_GAP ? "overrated" : error <= -SURPRISE_GAP ? "underrated" : null };
    }).sort((a, b) => a.cpr - b.cpr);
    const creative = group.filter((row) => row.creativeScore !== null);
    const big = group.length >= MIN_COHORT_FOR_RHO;
    return {
      market: group[0]!.market, postType: group[0]!.postType, posts,
      rho: big ? pearson(predicted, actual) : null,
      creativeRho: big && creative.length === group.length ? pearson(percentiles(group.map((row) => row.creativeScore!), true), actual) : null,
      meanAbsError: posts.reduce((sum, post) => sum + Math.abs(post.error), 0) / posts.length,
    };
  }).sort((a, b) => b.posts.length - a.posts.length);
  const graded = cohorts.reduce((sum, cohort) => sum + cohort.posts.length, 0);
  const withRho = cohorts.filter((cohort) => cohort.rho !== null);
  const weight = withRho.reduce((sum, cohort) => sum + cohort.posts.length, 0);
  return {
    cohorts, graded, awaitingEvidence: scored.length - graded,
    rho: weight ? withRho.reduce((sum, cohort) => sum + cohort.rho! * cohort.posts.length, 0) / weight : null,
    meanAbsError: graded ? cohorts.reduce((sum, cohort) => sum + cohort.meanAbsError * cohort.posts.length, 0) / graded : null,
    surprises: cohorts.flatMap((cohort) => cohort.posts.filter((post) => post.surprise)).sort((a, b) => Math.abs(b.error) - Math.abs(a.error)),
  };
}
