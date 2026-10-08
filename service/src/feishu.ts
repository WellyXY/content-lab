import type { ContentLabDatabase } from "./db/database.js";
import { putSyncEvent } from "./sync/outbox.js";

interface AlertRow {
  id: string; post_id: string | null; rule: string; fired_at: string; payload_json: string;
  delivery_attempts: number; site_post_id: string | null;
}

const compact = (value: number): string => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const safeText = (value: unknown): string => String(value).replace(/[<>&`]/g, (character) => ({ "<": "‹", ">": "›", "&": "＆", "`": "'" })[character] ?? character);

function cardForAlert(row: AlertRow, publicBaseUrl: string): Record<string, unknown> {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const postId = typeof payload.postId === "string" ? payload.postId : row.post_id;
  const title = row.rule === "milestone" ? "Content Lab · 播放里程碑" : row.rule === "acceleration" ? "Content Lab · 素材正在加速" : "Content Lab · 運維提醒";
  const current = typeof payload.currentViews === "number" ? compact(payload.currentViews) : "—";
  const previous = typeof payload.previousViews === "number" ? compact(payload.previousViews) : "—";
  const delta = typeof payload.delta === "number" ? `+${compact(payload.delta)}` : "—";
  const url = typeof payload.url === "string" ? payload.url : null;
  const detailUrl = postId ? `${publicBaseUrl}/posts/${encodeURIComponent(postId)}` : publicBaseUrl;
  const lines = [
    `**規則**：${row.rule}`,
    `**市場**：${safeText(payload.market ?? "—")}`,
    `**播放**：${current}（前值 ${previous}，變化 ${delta}）`,
    typeof payload.error === "string" ? `**錯誤**：${safeText(payload.error.slice(0, 500))}` : null,
    url ? `[查看 TikTok](${url}) · [查看曲線](${detailUrl})` : `[打開 Content Lab](${detailUrl})`,
  ].filter(Boolean).join("\n");
  return {
    msg_type: "interactive",
    card: {
      header: { template: row.rule.startsWith("ops_") ? "red" : "orange", title: { tag: "plain_text", content: title } },
      elements: [{ tag: "div", text: { tag: "lark_md", content: lines } }],
    },
  };
}

export async function deliverAlertOutbox(
  db: ContentLabDatabase,
  webhookUrl: string | null,
  publicBaseUrl: string,
  limit = 20,
): Promise<{ delivered: number; skipped: number; failed: number }> {
  if (!webhookUrl) return { delivered: 0, skipped: 0, failed: 0 };
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT a.id, a.post_id, a.rule, a.fired_at, a.payload_json, a.delivery_attempts, p.site_post_id
    FROM alerts a LEFT JOIN posts p ON p.id=a.post_id
    WHERE a.delivered_at IS NULL AND (a.next_delivery_at IS NULL OR a.next_delivery_at <= ?)
    ORDER BY a.fired_at LIMIT ?
  `).all(now, Math.max(1, Math.min(limit, 100))) as unknown as AlertRow[];
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(webhookUrl, {
        method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(cardForAlert(row, publicBaseUrl)),
      });
      const body = await response.json().catch(() => null) as { code?: number; StatusCode?: number; msg?: string } | null;
      const accepted = response.ok && (body?.code === 0 || body?.StatusCode === 0);
      if (!accepted) throw new Error(`Feishu returned ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
      const deliveredAt = new Date().toISOString();
      db.prepare("UPDATE alerts SET delivered_at=?, delivery_attempts=delivery_attempts+1, delivery_error=NULL WHERE id=? AND delivered_at IS NULL")
        .run(deliveredAt, row.id);
      putSyncEvent(db, "alert", row.id, { id: row.id, postId: row.site_post_id ?? row.post_id, sitePostId: row.site_post_id, localPostId: row.post_id, rule: row.rule, firedAt: row.fired_at, payload: JSON.parse(row.payload_json), deliveredAt }, deliveredAt);
      delivered += 1;
    } catch (error) {
      const attempts = row.delivery_attempts + 1;
      const retryAt = new Date(Date.now() + Math.min(60 * 60_000, 2 ** Math.min(attempts, 6) * 30_000)).toISOString();
      db.prepare("UPDATE alerts SET delivery_attempts=?, next_delivery_at=?, delivery_error=? WHERE id=?")
        .run(attempts, retryAt, error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000), row.id);
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  return { delivered, skipped: 0, failed };
}
