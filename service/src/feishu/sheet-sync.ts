import { existsSync, readFileSync } from "node:fs";

import { bindPlan, planLinks, type BindLimits } from "../bind.js";
import type { ContentLabDatabase } from "../db/database.js";
import { linksFromRows } from "./doc-links.js";
import { describeDocTables, loadDocTables, queryAllDocRows } from "./doc-sql.js";
import type { FeishuDocument } from "./docs.js";

/**
 * A Feishu sheet that is re-read every day: `sql` selects the rows to bind (same tables and helpers as the
 * agent's query_feishu_doc), returning the post link and a `market` column; `market` is the fallback.
 * Name tabs as {{tab name}} rather than t1, t2…, so adding or moving a tab cannot change which rows are read.
 * The list lives in a local file, so sheet links never enter the repository.
 */
export interface SheetSync { name: string; url: string; sql: string; market?: string }
export interface SheetSyncResult { name: string; rows: number; newLinks: number; alreadyTracked: number; queued: number; scheduled: number; invalid: number; noMarket: number; error?: string }

/** Taipei 09:30: an hour before the ads refresh, so posts bound today get their Spark Ads match the same day. */
const OFFSET_MS = 8 * 3_600_000;
const START_MINUTES = 9 * 60 + 30;

/** Replace each {{tab name}} with that tab's table; a missing tab is an error, never a silently empty result. */
export function resolveTabs(sql: string, tables: Array<{ table: string; tab: string }>): string {
  return sql.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
    const match = tables.find((item) => item.tab.trim() === name.trim());
    if (!match) throw new Error(`Tab "${name.trim()}" is not in the sheet (tabs: ${tables.map((item) => item.tab).join(", ")})`);
    return match.table;
  });
}

export function sheetSyncDue(now: Date): string | null {
  const local = new Date(now.getTime() + OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= START_MINUTES ? `sheet_sync:${local.toISOString().slice(0, 10)}` : null;
}

export function loadSheetSyncs(path: string): SheetSync[] {
  if (!existsSync(path)) return [];
  const list = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(list)) throw new Error(`${path} must be a JSON list of sheets`);
  return list.map((item, index) => {
    const entry = item as Partial<SheetSync>;
    if (!entry.name || !entry.url || !entry.sql) throw new Error(`Sheet ${index + 1} in ${path} needs name, url and sql`);
    return { name: entry.name, url: entry.url, sql: entry.sql, ...(entry.market ? { market: entry.market } : {}) };
  });
}

/** Read each sheet, bind its new posts under the daily quota (the rest wait for later days) and report per sheet; one failing sheet does not stop the others. */
export async function runSheetSyncs(
  db: ContentLabDatabase, limits: BindLimits, syncs: SheetSync[],
  read: (url: string, options?: { allTabs?: boolean }) => Promise<FeishuDocument>, now = new Date(),
): Promise<SheetSyncResult[]> {
  const results: SheetSyncResult[] = [];
  for (const sync of syncs) {
    try {
      const doc = await read(sync.url, { allTabs: true });
      const skipped = (doc.skippedTabs ?? []).filter((tab) => sync.sql.includes(`{{${tab}}}`));
      if (skipped.length) throw new Error(`Feishu could not provide ${skipped.join(", ")} yet; nothing was bound from this sheet today`);
      const tables = loadDocTables(doc);
      let rows: Array<Record<string, unknown>>;
      try { rows = queryAllDocRows(tables, resolveTabs(sync.sql, describeDocTables(tables))); } finally { tables.close(); }
      const plan = planLinks(db, linksFromRows(rows), sync.market ?? null);
      const alreadyTracked = Object.values(plan.byMarket).reduce((sum, item) => sum + item.alreadyTracked, 0);
      const { queued, scheduled, stoppedBy } = bindPlan(db, limits, plan, `sheet:${sync.name}`, now);
      results.push({ name: sync.name, rows: rows.length, newLinks: plan.totalNew, alreadyTracked, queued, scheduled, invalid: plan.invalid, noMarket: plan.noMarket, ...(stoppedBy ? { error: stoppedBy } : {}) });
    } catch (error) {
      results.push({ name: sync.name, rows: 0, newLinks: 0, alreadyTracked: 0, queued: 0, scheduled: 0, invalid: 0, noMarket: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
