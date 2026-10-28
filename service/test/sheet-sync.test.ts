import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import type { FeishuDocument } from "../src/feishu/docs.js";
import { loadSheetSyncs, runSheetSyncs, sheetSyncDue } from "../src/feishu/sheet-sync.js";

const url = (id: number) => `https://www.tiktok.com/@kol${id}/video/74400000000000${String(id).padStart(5, "0")}`;
const sheet = (rows: string[]): FeishuDocument => ({
  kind: "sheet", title: "KOL", text: "", truncated: false, tiktokUrls: [],
  lines: ["## TR-TT-2026", "Username\tPosting Date\tPosted link", ...rows],
});
const sql = "SELECT \"Posted link\", 'TR' AS market FROM {{TR-TT-2026}} WHERE to_date(\"Posting Date\") >= date('2026-10-27', '-30 days')";

describe("daily sheet sync", () => {
  it("binds each sheet's new recent posts once, keeps over-quota ones waiting and reports a failing sheet without stopping", async () => {
    const db = openDatabase(":memory:");
    const limits = { dailyNewPosts: 2, maxActivePosts: 1_000 };
    const now = new Date("2026-10-27T02:00:00.000Z");
    const docs: Record<string, FeishuDocument> = {
      good: sheet([`a\t22.10.26\t${url(1)}`, `b\t6 October 2026\t${url(2)}`, `c\tTue/ 1020\t${url(3)}`, `old\t1 August 2026\t${url(4)}`]),
    };
    const read = async (link: string) => { if (!docs[link]) throw new Error("no permission"); return docs[link]!; };
    const syncs = [{ name: "TR KOL", url: "good", sql }, { name: "locked", url: "locked", sql }];

    const first = await runSheetSyncs(db, limits, syncs, read, now);
    expect(first[0]).toMatchObject({ name: "TR KOL", rows: 3, newLinks: 3, queued: 2, scheduled: 1 });
    expect(first[1]).toMatchObject({ name: "locked", error: "no permission" });
    const renamed = await runSheetSyncs(db, limits, [{ name: "renamed", url: "good", sql: sql.replace("TR-TT-2026", "TR-KOL") }], read, now);
    expect(renamed[0]!.error).toMatch(/Tab "TR-KOL" is not in the sheet/);
    const notReady = await runSheetSyncs(db, limits, [{ name: "slow", url: "good", sql }], async () => ({ ...docs.good!, skippedTabs: ["TR-TT-2026"] }), now);
    expect(notReady[0]).toMatchObject({ queued: 0, error: expect.stringMatching(/could not provide TR-TT-2026/) });
    const bound = db.prepare("SELECT json_extract(payload_json, '$.boundBy') AS by, json_extract(payload_json, '$.market') AS market FROM jobs WHERE kind='ingest'").all();
    expect(bound).toEqual([{ by: "sheet:TR KOL", market: "TR" }, { by: "sheet:TR KOL", market: "TR" }]);

    // The next day nothing is bound twice.
    const again = await runSheetSyncs(db, limits, syncs.slice(0, 1), read, now);
    expect(again[0]).toMatchObject({ newLinks: 1, alreadyTracked: 2, queued: 0, scheduled: 0 });
    db.close();
  });

  it("runs from 09:30 Taipei and reads its list from a local file", () => {
    expect(sheetSyncDue(new Date("2026-10-27T01:29:00.000Z"))).toBeNull();
    expect(sheetSyncDue(new Date("2026-10-27T01:30:00.000Z"))).toBe("sheet_sync:2026-10-27");
    const dir = mkdtempSync(join(tmpdir(), "sheet-syncs-"));
    expect(loadSheetSyncs(join(dir, "missing.json"))).toEqual([]);
    writeFileSync(join(dir, "list.json"), JSON.stringify([{ name: "a", url: "u", sql: "SELECT 1" }]));
    expect(loadSheetSyncs(join(dir, "list.json"))).toEqual([{ name: "a", url: "u", sql: "SELECT 1" }]);
    writeFileSync(join(dir, "bad.json"), JSON.stringify([{ name: "a" }]));
    expect(() => loadSheetSyncs(join(dir, "bad.json"))).toThrow(/needs name, url and sql/);
  });
});
