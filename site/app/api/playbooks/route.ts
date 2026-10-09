import { MARKET_CODES, type PlaybookData, type PlaybookSummary } from "@/lib/content-lab";
import { getD1, jsonError, nullableInteger, nullableString, safeJson } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

const summary = (row: Record<string, unknown>): PlaybookSummary => ({
  id: String(row.id), market: String(row.market), version: Number(row.version), weekStart: String(row.week_start), createdAt: String(row.created_at),
});

/** Latest (or a chosen) playbook version for one market, plus its weekly history. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const market = url.searchParams.get("market")?.trim().toUpperCase() ?? "TR";
  if (!(MARKET_CODES as readonly string[]).includes(market)) return jsonError("市場不正確", 400);
  const version = nullableInteger(url.searchParams.get("version"));
  try {
    const db = getD1();
    const [historyResult, marketsResult] = await db.batch([
      db.prepare("SELECT id, market, version, week_start, created_at FROM playbooks WHERE market = ? ORDER BY version DESC LIMIT 52").bind(market),
      db.prepare("SELECT market, MAX(version) AS version FROM playbooks GROUP BY market"),
    ]);
    const chosen = version ?? nullableInteger((historyResult.results[0] as Record<string, unknown> | undefined)?.version);
    const row = chosen === null ? null : await db.prepare("SELECT * FROM playbooks WHERE market = ? AND version = ? LIMIT 1").bind(market, chosen).first<Record<string, unknown>>();
    const playbook: PlaybookData | null = row ? {
      ...summary(row), model: nullableString(row.model), markdown: String(row.markdown),
      document: safeJson<PlaybookData["document"]>(row.document_json, { summary_zh: "", patterns: [], anti_patterns: [], weekly_changes: [], open_questions_zh: [], sample_caveat_zh: "" }),
      evidence: safeJson<PlaybookData["evidence"]>(row.evidence_json, { eligiblePosts: 0, topSize: 0, bottomSize: 0, topMinViews: 0, medianViews: 0, stats: [], numeric: [], posts: [] }),
    } : null;
    return Response.json({
      market, playbook,
      history: historyResult.results.map((item) => summary(item as Record<string, unknown>)),
      markets: marketsResult.results.map((item) => ({ market: String((item as Record<string, unknown>).market), version: Number((item as Record<string, unknown>).version) })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("playbook read failed", error);
    return jsonError("暫時無法讀取爆款共性文檔", 503);
  }
}
