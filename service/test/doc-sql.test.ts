import { describe, expect, it } from "vitest";

import { describeDocTables, loadDocTables, queryDocTables } from "../src/feishu/doc-sql.js";
import type { FeishuDocument } from "../src/feishu/docs.js";

const url = (id: number) => `https://www.tiktok.com/@kol${id}/video/74300000000000${String(id).padStart(5, "0")}`;
const doc: FeishuDocument = {
  kind: "sheet", title: "KOL", text: "", truncated: false, tiktokUrls: [],
  lines: [
    "## 2025", "Creator\tArea\tChannel\tVideo Post Date\tLink", `a\tVN\tTT\t45700\t${url(1)}`,
    "## 2026", "Creator\tArea\tChannel\tVideo Post Date\tLink\tLink", `b\tVietnam\tTT\t46300\t${url(2)}\tx`, `c\tTR\tFB\t46300\t${url(3)}\t`, `d\tID\tTT\t46250\t视频 ${url(4)}\t`, `e\t土耳其\tTT\t2026-10-01\t${url(5)}\t`,
  ],
};

describe("a Feishu sheet as SQL tables", () => {
  it("makes one table per tab with the original column names and helper columns", () => {
    const db = loadDocTables(doc);
    const tables = describeDocTables(db);
    expect(tables.map((table) => [table.table, table.tab, table.rows])).toEqual([["t1", "2025", 1], ["t2", "2026", 4]]);
    expect(tables[1]!.columns).toEqual(["Creator", "Area", "Channel", "Video Post Date", "Link", "Link_2", "_row", "_links"]);
    // How full each column is and what it holds, so an almost empty date column is noticed.
    expect(tables[1]!.columnStats.find((column) => column.name === "Link_2")).toEqual({ name: "Link_2", filled: 1, sample: "x", dates: 0 });
    expect(tables[1]!.columnStats.find((column) => column.name === "Video Post Date")).toMatchObject({ filled: 4, dates: 4 });
    db.close();
  });

  it("answers a 2026, TikTok, last-30-days query with dates and markets understood", () => {
    const db = loadDocTables(doc);
    const result = queryDocTables(db, `SELECT _links AS link, market_of(Area) AS market FROM t2 WHERE Channel = 'TT' AND to_date("Video Post Date") >= date('2026-10-14', '-30 days') ORDER BY _row`);
    expect(result.rows).toEqual([{ link: url(2), market: "VN" }, { link: url(5), market: "TR" }]);
    expect(queryDocTables(db, `SELECT to_date("Video Post Date") AS d FROM t2 WHERE Creator = 'd'`).rows).toEqual([{ d: "2026-08-16" }]);
    db.close();
  });

  it("only runs one read-only SELECT and caps the rows it returns", () => {
    const db = loadDocTables(doc);
    expect(() => queryDocTables(db, "DELETE FROM t1")).toThrow(/SELECT/);
    expect(() => queryDocTables(db, "SELECT 1; SELECT 2")).toThrow(/single/);
    expect(queryDocTables(db, "WITH x AS (SELECT * FROM t2) SELECT COUNT(*) AS n FROM x").rows).toEqual([{ n: 4 }]);
    expect(queryDocTables(db, "SELECT * FROM t2", 2)).toMatchObject({ truncated: true });
    expect(() => queryDocTables(db, "SELECT * FROM pragma_database_list")).toThrow();
    expect(() => queryDocTables(db, "SELECT load_extension('/tmp/x')")).toThrow();
    db.close();
  });
});
