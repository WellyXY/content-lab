import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ServiceConfig } from "../config.js";
import type { ContentLabDatabase } from "../db/database.js";
import { AnalyzerQuotaError } from "../analyzer/claude.js";
import { RECREATION_ID, SourceUnavailableError } from "../recreate/workspace.js";
import { saveRecreation, type SaveFields, type Status } from "../recreate/run.js";
import { analyzeLayout, type ImageLayout } from "./layout.js";
import { copyPrompt, generateWithCodex } from "./generate.js";
import { compositeOverlays, overlayMask } from "./overlay.js";
import { readRgb, writeJpeg } from "./pixels.js";

/** Versions generated per photo, and Codex sessions run at once. */
export const VARIANTS_PER_IMAGE = 2;
const PARALLEL = 2;

export interface ImageCopyNotes {
  kind: "image_copy";
  summary_zh: string; summary_en: string;
  changes: Array<{ zh: string; en: string; suggestion: null }>;
  /** One entry per carousel image: the original, and the generated versions (none for kept screenshots). */
  images: Array<{ index: number; kept: boolean; original: string; variants: string[]; failed: number }>;
}

export interface ImageCopyDeps {
  upload: (recreationId: string, filename: string, path: string, contentType: string) => Promise<string>;
  notify?: (text: string) => Promise<void>;
  refresh?: (postId: string) => Promise<void>;
  analyze?: (config: ServiceConfig, images: string[]) => Promise<ImageLayout[]>;
  generate?: (dir: string, sourcePath: string, prompt: string) => Promise<string | null>;
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => { for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item); }));
}

/**
 * Copy a photo carousel: each photo is reshot by Codex as a local creator in a new outfit and place, keeping framing,
 * pose, mood and story; the original text and app UI are copied back pixel for pixel; full-screen UI images are kept.
 */
export async function runImageCopy(
  db: ContentLabDatabase, config: ServiceConfig,
  input: { recreationId: string; sitePostId: string; finalAttempt?: boolean }, deps: ImageCopyDeps,
): Promise<void> {
  const post = db.prepare("SELECT id, market FROM posts WHERE site_post_id=? OR id=? LIMIT 1").get(input.sitePostId, input.sitePostId) as { id: string; market: string | null } | undefined;
  const save = (status: Status, fields: SaveFields = {}) => saveRecreation(db, { id: input.recreationId, postId: post?.id ?? input.sitePostId, sitePostId: input.sitePostId }, status, fields);
  if (!post) { save("failed", { error: "post_not_tracked", counts: 0 }); return; }
  if (!RECREATION_ID.test(input.recreationId)) throw new Error("Invalid recreation id");
  const dir = resolve(config.mediaDir, "..", "recreate", input.recreationId);
  try {
    save("preparing");
    const mediaDir = join(config.mediaDir, post.id);
    const list = () => existsSync(mediaDir) ? readdirSync(mediaDir).filter((file) => /^img-\d+\.jpg$/.test(file)).sort().map((file) => join(mediaDir, file)) : [];
    if (!list().length) await deps.refresh?.(post.id);
    const sources = list();
    if (!sources.length) throw new SourceUnavailableError("No carousel images are stored for this post");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const layouts = await (deps.analyze ?? analyzeLayout)(config, sources);

    save("designing");
    const generated = new Map<string, string>();
    const tasks = layouts.filter((layout) => layout.kind === "photo").flatMap((layout) => Array.from({ length: VARIANTS_PER_IMAGE }, (_, v) => ({ layout, variant: v + 1 })));
    await pool(tasks, PARALLEL, async ({ layout, variant }) => {
      const source = sources[layout.index - 1]!;
      const size = await readRgb(source).then((image) => ({ width: image.width, height: image.height }));
      const workDir = join(dir, `img-${String(layout.index).padStart(2, "0")}-${variant}`);
      const prompt = copyPrompt({ market: post.market, scene: layout.scene, replace: layout.replace, ...size, variant });
      const base = await (deps.generate ?? ((d, s, p) => generateWithCodex(d, s, p, { model: config.codexModel })))(workDir, source, prompt).catch(() => null);
      if (base) generated.set(`${layout.index}-${variant}`, base);
    });

    save("rendering");
    const images: ImageCopyNotes["images"] = [];
    for (const layout of layouts) {
      const source = sources[layout.index - 1]!;
      const name = (variant: number) => `img-${String(layout.index).padStart(2, "0")}-${variant}.jpg`;
      const original = await deps.upload(input.recreationId, name(0), source, "image/jpeg");
      if (layout.kind === "screenshot") { images.push({ index: layout.index, kept: true, original, variants: [], failed: 0 }); continue; }
      const sourceRgb = await readRgb(source);
      const mask = overlayMask(sourceRgb, layout.overlays);
      const variants: string[] = [];
      for (let variant = 1; variant <= VARIANTS_PER_IMAGE; variant += 1) {
        const base = generated.get(`${layout.index}-${variant}`);
        if (!base) continue;
        const output = join(dir, name(variant));
        await writeJpeg(output, compositeOverlays(await readRgb(base, sourceRgb), sourceRgb, mask));
        variants.push(await deps.upload(input.recreationId, name(variant), output, "image/jpeg"));
      }
      images.push({ index: layout.index, kept: false, original, variants, failed: VARIANTS_PER_IMAGE - variants.length });
    }
    const made = images.reduce((sum, image) => sum + image.variants.length, 0);
    const photos = images.filter((image) => !image.kept).length;
    if (photos > 0 && made === 0) throw new Error("Codex generated no image");
    const kept = images.length - photos;
    const failed = images.reduce((sum, image) => sum + image.failed, 0);
    const notes: ImageCopyNotes = {
      kind: "image_copy",
      summary_zh: `${photos} 张照片各生成 ${VARIANTS_PER_IMAGE} 个版本（共 ${made} 张${failed ? `，${failed} 张生成失败` : ""}）${kept ? `，${kept} 张 App 截图保持原样` : ""}。文字和 App 界面从原图原样保留。`,
      summary_en: `${made} new images for ${photos} photos (${VARIANTS_PER_IMAGE} versions each${failed ? `, ${failed} failed` : ""})${kept ? `; ${kept} app screenshots kept as they are` : ""}. Text and app UI are copied from the original.`,
      changes: [], images,
    };
    const cover = images.find((image) => image.variants.length)?.variants[0];
    save("complete", { notes, ...(cover ? { coverUrl: cover } : {}) });
    await deps.notify?.(`一键复制完成 · post ${input.sitePostId}：${notes.summary_zh}`).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SourceUnavailableError) {
      save("failed", { error: "source_unavailable", counts: 0 });
      return;
    }
    if (error instanceof AnalyzerQuotaError) { save("queued", { error: "paused_for_quota" }); throw error; }
    if (input.finalAttempt) {
      save("failed", { error: "agent_failed" });
      await deps.notify?.(`一键复制失败 · post ${input.sitePostId}：${message.slice(0, 500)}`).catch(() => undefined);
    }
    throw error;
  }
}
