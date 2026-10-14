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
const MARKET_HEADER = /国家|國家|市场|市場|地区|地區|country|market|region/i;

export function marketFromCell(value: string | undefined): string | null {
  const key = (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return LOOKUP.get(key) ?? null;
}

export interface DocLink { url: string; market: string | null }

/** TikTok links of a document with each row's market, read from a country or market column when the table has one. */
export function extractDocLinks(doc: FeishuDocument): { links: DocLink[]; marketColumn: boolean } {
  const tabular = doc.kind !== "docx";
  const seen = new Set<string>();
  const links: DocLink[] = [];
  let header: string[] | null = null;
  let marketIndex = -1;
  let marketColumn = false;
  for (const line of doc.lines) {
    // Sheets and bases come as "## <sheet>" sections whose first row is the header.
    if (line.startsWith("## ")) { header = null; marketIndex = -1; continue; }
    const cells = line.split("\t");
    const urls = line.match(TIKTOK_URL) ?? [];
    if (tabular && header === null && urls.length === 0) {
      header = cells;
      marketIndex = cells.findIndex((cell) => MARKET_HEADER.test(cell));
      if (marketIndex >= 0) marketColumn = true;
      continue;
    }
    const market = marketIndex >= 0 ? marketFromCell(cells[marketIndex]) : null;
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ url, market });
    }
  }
  return { links, marketColumn };
}

/** What the model sees of a document: size, link counts per market and a short preview, never the whole text. */
export function summarizeDocument(doc: FeishuDocument) {
  const { links, marketColumn } = extractDocLinks(doc);
  const linksByMarket: Record<string, number> = {};
  for (const link of links) linksByMarket[link.market ?? "unknown"] = (linksByMarket[link.market ?? "unknown"] ?? 0) + 1;
  return {
    kind: doc.kind, title: doc.title, rows: doc.lines.length, links: links.length, linksByMarket, marketColumn,
    sampleLinks: links.slice(0, 5).map((link) => link.url),
    preview: doc.lines.slice(0, 20).map((line) => line.slice(0, 200)).join("\n"),
  };
}
