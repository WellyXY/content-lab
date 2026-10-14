import * as lark from "@larksuiteoapi/node-sdk";

/** GET a Feishu Open API path and return its `data`, throwing on a non-zero code. */
export type FeishuGet = (path: string, params?: Record<string, string | number>) => Promise<Record<string, unknown>>;

export interface FeishuDocument {
  kind: "docx" | "sheet" | "bitable";
  title: string | null;
  /** Plain text: paragraphs for documents, tab-separated rows for sheets and tables. */
  text: string;
  truncated: boolean;
  tiktokUrls: string[];
  /** Every line, untruncated: for program-side processing only, never for the model. */
  lines: string[];
}

const DOC_HOSTS = /(^|\.)(feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com)$/i;
const MAX_TEXT = 40_000;
const MAX_ROWS = 2_000;
export const TIKTOK_URL = /https:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/[^\s"'<>，。、；）)\]]+/gi;

export type FeishuDocRef = { kind: "docx" | "sheet" | "bitable" | "wiki"; token: string; sub: string | null };

export function parseFeishuDocUrl(input: string): FeishuDocRef {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("不是有效的飞书文档链接"); }
  if (url.protocol !== "https:" || !DOC_HOSTS.test(url.hostname)) throw new Error("只支持飞书 / Lark 的文档链接");
  const match = url.pathname.match(/\/(docx|sheets|base|wiki)\/([A-Za-z0-9]{8,64})/);
  if (!match) throw new Error("只支持新版文档（docx）、电子表格、多维表格和知识库链接");
  const kind = ({ docx: "docx", sheets: "sheet", base: "bitable", wiki: "wiki" } as const)[match[1] as "docx" | "sheets" | "base" | "wiki"];
  return { kind, token: match[2]!, sub: url.searchParams.get(kind === "sheet" ? "sheet" : "table") };
}

/** Text of a cell or block element: plain values, link segments, mentions. Links whose text hides the URL keep the URL. */
function flatten(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(" ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    const link = typeof item.link === "string" ? item.link : typeof item.url === "string" ? item.url : null;
    const text = typeof item.text === "string" ? item.text : typeof item.name === "string" ? item.name : null;
    if (link) return text && text !== link ? `${text} ${link}` : link;
    if (text) return text;
    return Object.values(item).map(flatten).filter(Boolean).join(" ");
  }
  return "";
}

/** Collect a docx block's text runs and any hyperlink targets. */
function blockText(block: unknown): string {
  const parts: string[] = [];
  const links: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === "content" && typeof child === "string") parts.push(child);
      else if (key === "url" && typeof child === "string") links.push(decodeURIComponent(child));
      else if (key !== "children" && key !== "block_id" && key !== "parent_id") walk(child);
    }
  };
  walk(block);
  const text = parts.join("");
  const hidden = links.filter((link) => !text.includes(link));
  return [text, ...hidden].filter(Boolean).join(" ");
}

async function paged(get: FeishuGet, path: string, params: Record<string, string | number>, limit: number): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const data = await get(path, { ...params, ...(pageToken ? { page_token: pageToken } : {}) });
    items.push(...((data.items as unknown[] | undefined) ?? []));
    pageToken = data.has_more ? data.page_token as string | undefined : undefined;
  } while (pageToken && items.length < limit);
  return items.slice(0, limit);
}

export async function readFeishuDocument(get: FeishuGet, input: string, options: { allTabs?: boolean } = {}): Promise<FeishuDocument> {
  let ref = parseFeishuDocUrl(input);
  // A link opened on one tab still lets the reader see every tab when asked.
  if (options.allTabs) ref = { ...ref, sub: null };
  let title: string | null = null;
  if (ref.kind === "wiki") {
    const node = (await get("/open-apis/wiki/v2/spaces/get_node", { token: ref.token })).node as { obj_type: string; obj_token: string; title?: string };
    const kind = node.obj_type === "docx" ? "docx" : node.obj_type === "sheet" ? "sheet" : node.obj_type === "bitable" ? "bitable" : null;
    if (!kind) throw new Error(`知识库里的这个页面是 ${node.obj_type}，暂不支持读取`);
    ref = { kind, token: node.obj_token, sub: ref.sub };
    title = node.title ?? null;
  }
  const lines: string[] = [];
  if (ref.kind === "docx") {
    const blocks = await paged(get, `/open-apis/docx/v1/documents/${ref.token}/blocks`, { page_size: 500 }, 5_000);
    for (const block of blocks) {
      const line = blockText(block).trim();
      if (line) lines.push(line);
    }
  } else if (ref.kind === "sheet") {
    const sheets = ((await get(`/open-apis/sheets/v3/spreadsheets/${ref.token}/sheets/query`)).sheets as Array<{ sheet_id: string; title: string }> | undefined) ?? [];
    const chosen = ref.sub ? sheets.filter((sheet) => sheet.sheet_id === ref.sub) : sheets;
    for (const sheet of chosen.slice(0, 20)) {
      const range = (await get(`/open-apis/sheets/v2/spreadsheets/${ref.token}/values/${encodeURIComponent(`${sheet.sheet_id}!A1:Z${MAX_ROWS}`)}`)).valueRange as { values?: unknown[][] } | undefined;
      if (chosen.length > 1) lines.push(`## ${sheet.title}`);
      for (const row of range?.values ?? []) {
        const cells = row.map((cell) => flatten(cell).replace(/\s+/g, " ").trim());
        if (cells.some(Boolean)) lines.push(cells.join("\t").replace(/\t+$/, ""));
      }
    }
  } else {
    const tables = await paged(get, `/open-apis/bitable/v1/apps/${ref.token}/tables`, { page_size: 100 }, 100) as Array<{ table_id: string; name: string }>;
    const chosen = ref.sub ? tables.filter((table) => table.table_id === ref.sub) : tables;
    for (const table of chosen.slice(0, 20)) {
      const records = await paged(get, `/open-apis/bitable/v1/apps/${ref.token}/tables/${table.table_id}/records`, { page_size: 500 }, MAX_ROWS) as Array<{ fields: Record<string, unknown> }>;
      const columns = [...new Set(records.flatMap((record) => Object.keys(record.fields)))];
      if (chosen.length > 1) lines.push(`## ${table.name}`);
      lines.push(columns.join("\t"));
      for (const record of records) lines.push(columns.map((column) => flatten(record.fields[column]).replace(/\s+/g, " ").trim()).join("\t"));
    }
  }
  const full = lines.join("\n");
  const tiktokUrls = [...new Set(full.match(TIKTOK_URL) ?? [])];
  return { kind: ref.kind as FeishuDocument["kind"], title, text: full.slice(0, MAX_TEXT), truncated: full.length > MAX_TEXT, tiktokUrls, lines };
}

/** A tenant-token client for the bot app; the document must be shared with the app or readable in the organization. */
export function createFeishuDocReader(appId: string, appSecret: string): (url: string, options?: { allTabs?: boolean }) => Promise<FeishuDocument> {
  const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn });
  const get: FeishuGet = async (path, params) => {
    let response: { code?: number; msg?: string; data?: Record<string, unknown> };
    try {
      response = await client.request({ method: "GET", url: path, params });
    } catch (error) {
      const body = (error as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
      throw new Error(body ? `飞书接口错误 ${body.code}: ${body.msg}` : error instanceof Error ? error.message : String(error));
    }
    if (response.code !== 0) throw new Error(`飞书接口错误 ${response.code}: ${response.msg}`);
    return response.data ?? {};
  };
  return (url, options) => readFeishuDocument(get, url, options);
}
