import { describe, expect, it } from "vitest";

import { extractDocLinks, marketFromCell, summarizeDocument } from "../src/feishu/doc-links.js";
import type { FeishuDocument } from "../src/feishu/docs.js";

const url = (id: number) => `https://www.tiktok.com/@kol${id}/video/74000000000000${String(id).padStart(5, "0")}`;
const sheet = (lines: string[]): FeishuDocument => ({ kind: "sheet", title: "KOL", text: lines.join("\n").slice(0, 40_000), truncated: false, tiktokUrls: [], lines });

describe("market names in documents", () => {
  it("maps country names and codes in Chinese and English to market codes", () => {
    expect(marketFromCell("越南")).toBe("VN");
    expect(marketFromCell("Vietnam")).toBe("VN");
    expect(marketFromCell(" tr ")).toBe("TR");
    expect(marketFromCell("土耳其")).toBe("TR");
    expect(marketFromCell("伊拉克")).toBe("IQ");
    expect(marketFromCell("印尼")).toBe("ID");
    expect(marketFromCell("沙特")).toBe("GCC");
    expect(marketFromCell("泰國")).toBe("TH");
    expect(marketFromCell("火星")).toBeNull();
  });
});

describe("links from a document", () => {
  it("takes each row's market from the country column, across sheets", () => {
    const doc = sheet(["## 越南", "达人\t国家\t链接", `a\t越南\t${url(1)}`, `b\tVN\t视频 ${url(2)}`, "## 土耳其", "creator\tcountry\tlink", `c\tTürkiye\t${url(3)}`, `d\t\t${url(4)}`, `e\tTR\thttps://www.tiktok.com/@someone`]);
    const result = extractDocLinks(doc);
    expect(result.links).toEqual([
      { url: url(1), market: "VN" }, { url: url(2), market: "VN" }, { url: url(3), market: "TR" }, { url: url(4), market: "TR" }, { url: "https://www.tiktok.com/@someone", market: "TR" },
    ]);
    expect(result.marketColumn).toBe(true);
  });

  it("has no market for a document without a country column", () => {
    const doc: FeishuDocument = { kind: "docx", title: "笔记", text: `看这个 ${url(5)}`, truncated: false, tiktokUrls: [url(5)], lines: [`看这个 ${url(5)}`] };
    expect(extractDocLinks(doc)).toEqual({ links: [{ url: url(5), market: null }], marketColumn: false });
  });

  it("summarizes a large sheet in a few kilobytes instead of returning it whole", () => {
    const lines = ["达人\t国家\t链接", ...Array.from({ length: 2_000 }, (_, index) => `kol${index}\t越南\t${url(index)}`)];
    const summary = summarizeDocument(sheet(lines));
    expect(JSON.stringify(summary).length).toBeLessThan(8_000);
    expect(summary).toMatchObject({ rows: 2_001, links: 2_000, linksByMarket: { VN: 2_000 }, marketColumn: true });
    expect(summary.preview.split("\n").length).toBeLessThanOrEqual(21);
  });
});

import { selectDocLinks, sheetTabs } from "../src/feishu/doc-links.js";

describe("choosing rows from a multi-tab sheet", () => {
  // Spreadsheet date numbers: 46300 = 2026-10-05, 46250 = 2026-08-16.
  const doc = sheet([
    "## 2025", "Creator\tArea\tChannel\tVideo Post Date\tLink", `a\tVN\tTT\t45700\t${url(1)}`,
    "## 2026", "Creator\tArea\tChannel\tVideo Post Date\tLink",
    `b\tVietnam\tTT\t46300\t${url(2)}`, `c\tTR\tFB\t46300\t${url(3)}`, `d\tID\tTT\t46250\t${url(4)}`, `e\tTR\tTT\t2026-10-01\t${url(5)}`, `f\tTR\tTT\t\t${url(6)}`,
    "## ID-TT-KOL", "Creator\tLink", `g\t${url(7)}`,
  ]);
  const now = new Date("2026-10-14T12:00:00Z");

  it("lists the tabs with their headers so the agent can pick columns", () => {
    expect(sheetTabs(doc).map((tab) => [tab.title, tab.rows, tab.header.join("|")])).toEqual([["2025", 1, "Creator|Area|Channel|Video Post Date|Link"], ["2026", 5, "Creator|Area|Channel|Video Post Date|Link"], ["ID-TT-KOL", 1, "Creator|Link"]]);
  });

  it("filters by tab, channel and post date, and reads the market from Area", () => {
    const result = selectDocLinks(doc, { tab: "2026", filters: [{ column: "Channel", equals: "TT" }], dateColumn: "Video Post Date", days: 30, now });
    expect(result.links).toEqual([{ url: url(2), market: "VN" }, { url: url(5), market: "TR" }]);
    expect(result.excluded).toMatchObject({ byFilter: 1, byDate: 1, noDate: 1 });
  });

  it("takes the market from the tab name when rows have no country", () => {
    expect(selectDocLinks(doc, { tab: "ID-TT-KOL", now }).links).toEqual([{ url: url(7), market: "ID" }]);
  });

  it("refuses a column that is not in the tab", () => {
    expect(() => selectDocLinks(doc, { tab: "2026", dateColumn: "Posted", days: 30, now })).toThrow(/Posted/);
  });
});
