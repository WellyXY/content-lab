import { readFileSync } from "node:fs";
import { basename } from "node:path";

import * as lark from "@larksuiteoapi/node-sdk";

/** What a daily update document is made of; the writer turns it into Feishu blocks. */
export type DocItem =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "text"; runs: Array<{ text: string; link?: string; bold?: boolean }> }
  | { kind: "bullet"; runs: Array<{ text: string; link?: string; bold?: boolean }> }
  /** Images side by side with a caption under each (e.g. the original and its copies). */
  | { kind: "images"; images: Array<{ path: string; caption: string }> };

export interface DocWriter {
  /** Create the document, readable by everyone in the organization who has the link. Returns its URL. */
  write: (title: string, items: DocItem[]) => Promise<{ url: string; documentId: string }>;
}

type Request = (request: { method: string; url: string; data?: unknown; params?: Record<string, string | number> }) => Promise<{ code?: number; msg?: string; data?: Record<string, unknown> }>;

const textBlock = (type: number, key: string, runs: Array<{ text: string; link?: string; bold?: boolean }>): Record<string, unknown> => ({
  block_type: type,
  [key]: { elements: runs.filter((run) => run.text).map((run) => ({ text_run: { content: run.text, text_element_style: { ...(run.bold ? { bold: true } : {}), ...(run.link ? { link: { url: encodeURIComponent(run.link) } } : {}) } } })) },
});

/** The blocks for the items that are plain text; images are placed separately because each needs an upload. */
export function itemBlock(item: Exclude<DocItem, { kind: "images" }>): Record<string, unknown> {
  if (item.kind === "heading") return textBlock(2 + item.level, `heading${item.level}`, [{ text: item.text }]);
  if (item.kind === "bullet") return textBlock(12, "bullet", item.runs);
  return textBlock(2, "text", item.runs);
}

export function createFeishuDocWriter(appId: string, appSecret: string, options: { host?: string } = {}): DocWriter {
  const silent = (): void => undefined;
  const client = new lark.Client({ appId, appSecret, logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent } });
  const call: Request = async (request) => {
    let response: { code?: number; msg?: string; data?: Record<string, unknown> };
    try {
      response = await client.request(request as Parameters<typeof client.request>[0]);
    } catch (error) {
      const body = (error as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
      throw new Error(body ? `飞书接口错误 ${body.code}: ${body.msg}` : error instanceof Error ? error.message : String(error));
    }
    if (response.code !== 0) throw new Error(`飞书接口错误 ${response.code}: ${response.msg}`);
    return response;
  };
  const addChildren = async (documentId: string, parent: string, children: Array<Record<string, unknown>>): Promise<Array<{ block_id: string; children?: string[] }>> => {
    const response = await call({ method: "POST", url: `/open-apis/docx/v1/documents/${documentId}/blocks/${parent}/children`, data: { children } });
    return (response.data?.children as Array<{ block_id: string; children?: string[] }> | undefined) ?? [];
  };
  const placeImage = async (documentId: string, parent: string, image: { path: string; caption: string }): Promise<void> => {
    const [block] = await addChildren(documentId, parent, [{ block_type: 27, image: {} }]);
    if (!block) throw new Error("Feishu did not create the image block");
    const file = readFileSync(image.path);
    const uploaded = await client.drive.v1.media.uploadAll({ data: { file_name: basename(image.path), parent_type: "docx_image", parent_node: block.block_id, size: file.length, file } });
    const token = (uploaded as { file_token?: string } | null)?.file_token;
    if (!token) throw new Error("Feishu did not return a token for the uploaded image");
    await call({ method: "PATCH", url: `/open-apis/docx/v1/documents/${documentId}/blocks/${block.block_id}`, data: { replace_image: { token } } });
    if (image.caption) await addChildren(documentId, parent, [textBlock(2, "text", [{ text: image.caption }])]);
  };
  return {
    async write(title, items) {
      const created = await call({ method: "POST", url: "/open-apis/docx/v1/documents", data: { title } });
      const documentId = (created.data?.document as { document_id?: string } | undefined)?.document_id;
      if (!documentId) throw new Error("Feishu did not return a document id");
      let pending: Array<Record<string, unknown>> = [];
      const flush = async (): Promise<void> => {
        // The API takes at most 50 blocks per call.
        for (let start = 0; start < pending.length; start += 50) await addChildren(documentId, documentId, pending.slice(start, start + 50));
        pending = [];
      };
      for (const item of items) {
        if (item.kind !== "images") { pending.push(itemBlock(item)); continue; }
        await flush();
        const columns = Math.min(item.images.length, 5);
        if (columns < 2) { for (const image of item.images) await placeImage(documentId, documentId, image); continue; }
        // A grid keeps the original beside its copies; each column holds one image and its caption.
        const [grid] = await addChildren(documentId, documentId, [{ block_type: 24, grid: { column_size: columns } }]);
        const columnIds = grid?.children ?? [];
        for (const [index, image] of item.images.slice(0, columns).entries()) await placeImage(documentId, columnIds[index] ?? documentId, image);
      }
      await flush();
      await call({ method: "PATCH", url: `/open-apis/drive/v1/permissions/${documentId}/public`, params: { type: "docx" }, data: { link_share_entity: "tenant_readable" } });
      return { documentId, url: `https://${options.host ?? "feishu.cn"}/docx/${documentId}` };
    },
  };
}
