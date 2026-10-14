import { TIKTOK_URL, type FeishuDocument } from "./docs.js";

/** Country names and codes people write in sheets, mapped to market codes. "中东" stays unknown: it could be GCC or IQ. */
const MARKET_ALIASES: Record<string, string[]> = {
  VN: ["vn", "vietnam", "viet nam", "việt nam", "越南"],
  ID: ["id", "indonesia", "印尼", "印度尼西亚", "印度尼西亞"],
  TR: ["tr", "turkey", "türkiye", "turkiye", "土耳其"],
  GCC: ["gcc", "海湾", "海灣", "海湾地区", "saudi", "saudi arabia", "ksa", "沙特", "沙特阿拉伯", "uae", "阿联酋", "阿聯酋", "kuwait", "科威特", "qatar", "卡塔尔", "卡達"],
  TH: ["th", "thailand", "泰国", "泰國"],
  IQ: ["iq", "iraq", "伊拉克"],
};
const LOOKUP = new Map(Object.entries(MARKET_ALIASES).flatMap(([market, names]) => names.map((name) => [name, market] as const)));
const MARKET_HEADER = /国家|國家|市场|市場|地区|地區|country|market|region|area|geo|nation/i;
const DATE_HEADER = /date|日期|发布|發布|posted|publish/i;
const DAY = 86_400_000;

export function marketFromCell(value: string | undefined): string | null {
  const key = (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return LOOKUP.get(key) ?? null;
}

export interface DocLink { url: string; market: string | null }
export interface Section { title: string; header: string[]; rows: string[][] }

/** Sheets and bases come as "## <tab>" sections whose first row is the header; a single tab or a document has none. */
export function docSections(doc: FeishuDocument): Section[] {
  const tabular = doc.kind !== "docx";
  const result: Section[] = [];
  let current: Section | null = null;
  for (const line of doc.lines) {
    if (line.startsWith("## ")) { current = { title: line.slice(3).trim(), header: [], rows: [] }; result.push(current); continue; }
    if (!current) { current = { title: doc.title ?? "", header: [], rows: [] }; result.push(current); }
    const cells = line.split("\t");
    if (tabular && current.header.length === 0 && current.rows.length === 0 && !(line.match(TIKTOK_URL)?.length)) current.header = cells;
    else current.rows.push(cells);
  }
  return result;
}

export function sheetTabs(doc: FeishuDocument): Array<{ title: string; rows: number; header: string[]; sample: string[] }> {
  return docSections(doc).map((section) => ({ title: section.title, rows: section.rows.length, header: section.header, sample: (section.rows[0] ?? []).map((cell) => cell.slice(0, 80)) }));
}

/** A cell as a date: spreadsheet serial numbers, ISO-like dates, day/month/year, or Unix timestamps. */
export function parseDate(value: string | undefined): number | null {
  // "Thursday 20260917", "Friday, 2026-09-18": drop a leading weekday; "2026 - 09 - 18": drop spaces around separators.
  const text = (value ?? "").trim().replace(/^[A-Za-z]+,?\s+(?=\d)/, "").replace(/\s*([-/.])\s*/g, "$1");
  if (!text) return null;
  const compact = text.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (compact) return Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (number >= 20_000 && number <= 80_000) return Date.UTC(1899, 11, 30) + Math.floor(number) * DAY;
    if (number > 1e12) return number;
    if (number > 1e9) return number * 1000;
    return null;
  }
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (match) return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return null;
}

const findColumn = (header: string[], name: string): number => {
  const wanted = name.trim().toLowerCase();
  const exact = header.findIndex((cell) => cell.trim().toLowerCase() === wanted);
  return exact >= 0 ? exact : header.findIndex((cell) => cell.trim().toLowerCase().includes(wanted));
};
/** A market named in a tab title such as "ID-TT-KOL". */
const marketFromTitle = (title: string): string | null => title.split(/[\s\-_/|·,，]+/).map(marketFromCell).find((market) => market !== null) ?? null;

export interface RowSelection {
  tab?: string;
  marketColumn?: string;
  dateColumn?: string;
  days?: number;
  filters?: Array<{ column: string; equals?: string | undefined; contains?: string | undefined }>;
  now?: Date;
}

/**
 * TikTok links from the chosen rows: one tab (by name), rows matching column filters and posted within `days`,
 * each with its market from the country column, else from the tab name.
 */
export function selectDocLinks(doc: FeishuDocument, selection: RowSelection = {}): { links: DocLink[]; marketColumn: boolean; excluded: { byFilter: number; byDate: number; noDate: number } } {
  let chosen = docSections(doc);
  if (selection.tab) {
    const wanted = selection.tab.trim().toLowerCase();
    const exact = chosen.filter((section) => section.title.trim().toLowerCase() === wanted);
    const partial = chosen.filter((section) => section.title.toLowerCase().includes(wanted));
    chosen = exact.length ? exact : partial;
    if (!chosen.length) throw new Error(`No tab named "${selection.tab}"; tabs: ${docSections(doc).map((section) => section.title).join(", ")}`);
  }
  const since = selection.days ? (selection.now ?? new Date()).getTime() - selection.days * DAY : null;
  const seen = new Set<string>();
  const links: DocLink[] = [];
  const excluded = { byFilter: 0, byDate: 0, noDate: 0 };
  let marketColumn = false;
  for (const section of chosen) {
    const column = (name: string): number => {
      const index = findColumn(section.header, name);
      if (index < 0) throw new Error(`Tab "${section.title}" has no column "${name}"; columns: ${section.header.join(", ")}`);
      return index;
    };
    const marketIndex = selection.marketColumn ? column(selection.marketColumn) : section.header.findIndex((cell) => MARKET_HEADER.test(cell));
    if (marketIndex >= 0) marketColumn = true;
    const dateIndex = since === null ? -1 : selection.dateColumn ? column(selection.dateColumn) : section.header.findIndex((cell) => DATE_HEADER.test(cell));
    if (since !== null && dateIndex < 0) throw new Error(`Tab "${section.title}" has no date column; name one with date_column. Columns: ${section.header.join(", ")}`);
    const filters = (selection.filters ?? []).map((filter) => ({ ...filter, index: column(filter.column) }));
    const tabMarket = marketFromTitle(section.title);
    for (const cells of section.rows) {
      const passes = filters.every((filter) => {
        const cell = (cells[filter.index] ?? "").trim().toLowerCase();
        return filter.equals !== undefined ? cell === filter.equals.trim().toLowerCase() : filter.contains !== undefined ? cell.includes(filter.contains.trim().toLowerCase()) : true;
      });
      if (!passes) { excluded.byFilter += 1; continue; }
      if (since !== null) {
        const date = parseDate(cells[dateIndex]);
        if (date === null) { excluded.noDate += 1; continue; }
        if (date < since) { excluded.byDate += 1; continue; }
      }
      const market = (marketIndex >= 0 ? marketFromCell(cells[marketIndex]) : null) ?? tabMarket;
      for (const url of cells.join("\t").match(TIKTOK_URL) ?? []) {
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({ url, market });
      }
    }
  }
  return { links, marketColumn, excluded };
}

/** Every TikTok link of a document with its market. */
export function extractDocLinks(doc: FeishuDocument): { links: DocLink[]; marketColumn: boolean } {
  const { links, marketColumn } = selectDocLinks(doc);
  return { links, marketColumn };
}

/** What the model sees of a document: size, link counts per market and a short preview, never the whole text. */
export function summarizeDocument(doc: FeishuDocument) {
  const { links, marketColumn } = extractDocLinks(doc);
  const linksByMarket: Record<string, number> = {};
  for (const link of links) linksByMarket[link.market ?? "unknown"] = (linksByMarket[link.market ?? "unknown"] ?? 0) + 1;
  return {
    kind: doc.kind, title: doc.title, rows: doc.lines.length, links: links.length, linksByMarket, marketColumn,
    tabs: sheetTabs(doc).slice(0, 20).map((tab) => ({ title: tab.title, rows: tab.rows, header: tab.header.slice(0, 20).map((cell) => cell.slice(0, 40)), sample: tab.sample.slice(0, 20) })),
    sampleLinks: links.slice(0, 5).map((link) => link.url),
    preview: doc.lines.slice(0, 20).map((line) => line.slice(0, 200)).join("\n"),
  };
}
