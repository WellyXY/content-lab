import { describe, expect, it } from "vitest";

import { parseFeishuDocUrl, readFeishuDocument, type FeishuGet } from "../src/feishu/docs.js";

const video = (id: string) => `https://www.tiktok.com/@kol/video/${id}`;

function fake(routes: Record<string, unknown>): { get: FeishuGet; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      const data = routes[path];
      if (!data) throw new Error(`unexpected ${path}`);
      return data as Record<string, unknown>;
    },
  };
}

describe("reading Feishu documents", () => {
  it("parses document, sheet, base and wiki links and rejects other hosts", () => {
    expect(parseFeishuDocUrl("https://acme.feishu.cn/docx/AbCdEfGh12345678")).toEqual({ kind: "docx", token: "AbCdEfGh12345678", sub: null });
    expect(parseFeishuDocUrl("https://acme.feishu.cn/sheets/Sht0000000001?sheet=a1b2c3")).toMatchObject({ kind: "sheet", sub: "a1b2c3" });
    expect(parseFeishuDocUrl("https://acme.larksuite.com/base/Bas0000000001?table=tblX")).toMatchObject({ kind: "bitable", sub: "tblX" });
    expect(parseFeishuDocUrl("https://acme.feishu.cn/wiki/Wik0000000001")).toMatchObject({ kind: "wiki" });
    expect(() => parseFeishuDocUrl("https://feishu.cn.example.com/docx/AbCdEfGh12345678")).toThrow();
    expect(() => parseFeishuDocUrl("https://acme.feishu.cn/drive/folder/x")).toThrow();
  });

  it("keeps hyperlink targets hidden behind link text in a document", async () => {
    const { get } = fake({
      "/open-apis/docx/v1/documents/AbCdEfGh12345678/blocks": { has_more: false, items: [
        { block_id: "root", page: { elements: [{ text_run: { content: "越南 KOL 帖子" } }] } },
        { block_id: "b1", bullet: { elements: [{ text_run: { content: "第一条 " } }, { text_run: { content: "点这里", text_element_style: { link: { url: encodeURIComponent(video("7400000000000000001")) } } } }] } },
        { block_id: "b2", text: { elements: [{ text_run: { content: `${video("7400000000000000002")}，备注` } }] } },
      ] },
    });
    const doc = await readFeishuDocument(get, "https://acme.feishu.cn/docx/AbCdEfGh12345678");
    expect(doc.text.split("\n")[1]).toBe(`第一条 点这里 ${video("7400000000000000001")}`);
    expect(doc.tiktokUrls).toEqual([video("7400000000000000001"), video("7400000000000000002")]);
  });

  it("reads spreadsheet rows, including link cells, so a market column survives", async () => {
    const { get } = fake({
      "/open-apis/sheets/v3/spreadsheets/Sht0000000001/sheets/query": { sheets: [{ sheet_id: "s1", title: "帖子" }] },
      [`/open-apis/sheets/v2/spreadsheets/Sht0000000001/values/${encodeURIComponent("s1!A1:Z2000")}`]: { valueRange: { values: [
        ["市场", "链接", null],
        ["越南", [{ type: "url", text: "视频", link: video("7400000000000000003") }], null],
        ["土耳其", video("7400000000000000004"), null],
      ] } },
    });
    const doc = await readFeishuDocument(get, "https://acme.feishu.cn/sheets/Sht0000000001");
    expect(doc.text).toBe(`市场\t链接\n越南\t视频 ${video("7400000000000000003")}\n土耳其\t${video("7400000000000000004")}`);
    expect(doc.tiktokUrls).toHaveLength(2);
  });

  it("follows a wiki page to the base it holds and pages through records", async () => {
    const { get } = fake({
      "/open-apis/wiki/v2/spaces/get_node": { node: { obj_type: "bitable", obj_token: "Bas0000000001", title: "达人素材" } },
      "/open-apis/bitable/v1/apps/Bas0000000001/tables": { has_more: false, items: [{ table_id: "tbl1", name: "表1" }] },
      "/open-apis/bitable/v1/apps/Bas0000000001/tables/tbl1/records": { has_more: false, items: [
        { fields: { 国家: "TR", 链接: { link: video("7400000000000000005"), text: video("7400000000000000005") } } },
        { fields: { 国家: "VN", 链接: [{ type: "url", text: "这条", link: video("7400000000000000006") }] } },
      ] },
    });
    const doc = await readFeishuDocument(get, "https://acme.feishu.cn/wiki/Wik0000000001");
    expect(doc).toMatchObject({ kind: "bitable", title: "达人素材" });
    expect(doc.text).toBe(`国家\t链接\nTR\t${video("7400000000000000005")}\nVN\t这条 ${video("7400000000000000006")}`);
  });
});

describe("sheet values", () => {
  it("asks for computed values so formula cells come back as results, not formulas", async () => {
    const params: Array<Record<string, string | number> | undefined> = [];
    const get: FeishuGet = async (path, query) => {
      params.push(query);
      if (path.endsWith("/sheets/query")) return { sheets: [{ sheet_id: "s1", title: "T" }] };
      return { valueRange: { values: [["Date"], [46300]] } };
    };
    await readFeishuDocument(get, "https://acme.feishu.cn/sheets/Sht0000000001");
    expect(params.at(-1)).toMatchObject({ valueRenderOption: "UnformattedValue" });
  });
});

describe("long sheets", () => {
  it("reads every row and column of a tab in batches, not just the first 2,000 rows to column Z", async () => {
    const ranges: string[] = [];
    const get: FeishuGet = async (path) => {
      if (path.endsWith("/sheets/query")) return { sheets: [{ sheet_id: "s1", title: "ID-TT", grid_properties: { row_count: 4_500, column_count: 30 } }] };
      const range = decodeURIComponent(path.split("/values/")[1]!);
      ranges.push(range);
      const [, start] = range.match(/!A(\d+):/)!;
      const first = Number(start);
      const values = first === 1 ? [["Area", "Video Post Date", "Link"], ...Array.from({ length: 1_999 }, () => ["ID", 46000, "x"])] : Array.from({ length: first > 4_000 ? 500 : 2_000 }, (_, index) => ["ID", 46300, index === 0 ? `https://www.tiktok.com/@k/video/74500000000000${first}` : "x"]);
      return { valueRange: { values } };
    };
    const doc = await readFeishuDocument(get, "https://acme.feishu.cn/sheets/Sht0000000001");
    expect(ranges).toEqual(["s1!A1:AD2000", "s1!A2001:AD4000", "s1!A4001:AD4500"]);
    expect(doc.lines).toHaveLength(4_500);
    expect(doc.lines.at(-1)).toContain("46300");
  });
});
