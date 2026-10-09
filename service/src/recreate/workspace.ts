import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { prepareMedia, type PreparedMedia } from "../analyzer/media.js";
import { latestPlaybook, renderPlaybookMarkdown } from "../analyzer/playbook.js";
import { MARKET_LANGUAGES, transcribePost } from "../analyzer/transcribe.js";
import { memoriesFor, ownerMemoryBlock } from "../agent/memory.js";
import type { ServiceConfig } from "../config.js";
import type { ContentLabDatabase } from "../db/database.js";
import { buildRecreateBrief, type RecreateInputs } from "./brief.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** HyperFrames skills the session may load; copied so only project settings are read. */
const SKILLS = ["hyperframes", "hyperframes-core", "hyperframes-animation", "hyperframes-cli", "hyperframes-creative", "hyperframes-keyframes", "motion-graphics"];

/** The source video cannot be obtained; the attempt does not count against the post's limit. */
export class SourceUnavailableError extends Error {}

export interface RecreateWorkspace { dir: string; sourceDurationS: number }

type WorkspacePost = { id: string; type: string | null; media_url: string | null; image_urls_json: string | null; duration_s: number | null; market: string | null; caption: string | null };

export async function prepareRecreateWorkspace(
  db: ContentLabDatabase,
  config: Pick<ServiceConfig, "mediaDir"> & Partial<Pick<ServiceConfig, "whisperModel">>,
  input: { recreationId: string; postId: string },
  deps: { refresh: (postId: string) => Promise<void>; init?: (dir: string) => Promise<void> },
): Promise<RecreateWorkspace> {
  const dir = join(config.mediaDir, "..", "recreate", input.recreationId);
  // A retried job always starts from a clean workspace.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // HyperFrames only scaffolds into an empty directory.
  await (deps.init ?? initHyperframes)(dir);
  mkdirSync(join(dir, "assets", "frames"), { recursive: true });
  const loadPost = () => db.prepare("SELECT id, type, media_url, image_urls_json, duration_s, market, caption FROM posts WHERE id=?").get(input.postId) as WorkspacePost | undefined;
  let post = loadPost();
  if (!post) throw new SourceUnavailableError(`Unknown post ${input.postId}`);
  if (post.type === "photo") throw new SourceUnavailableError("Carousel posts cannot be recreated yet");
  let prepared: PreparedMedia;
  try {
    prepared = await prepareMedia(config.mediaDir, post);
  } catch {
    // Signed media URLs expire: refresh once, then download again.
    await deps.refresh(input.postId);
    post = loadPost() ?? post;
    rmSync(join(config.mediaDir, post.id, "source.mp4"), { force: true });
    try {
      prepared = await prepareMedia(config.mediaDir, post);
    } catch (error) {
      throw new SourceUnavailableError(`Source video unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const postDir = join(config.mediaDir, post.id);
  cpSync(join(postDir, "source.mp4"), join(dir, "assets", "source.mp4"));
  for (const frame of prepared.frames) cpSync(join(postDir, frame.file), join(dir, "assets", "frames", frame.file));
  cpSync(join(REPO_ROOT, "brand", "popup"), join(dir, "brand"), { recursive: true });
  for (const skill of SKILLS) {
    const source = join(homedir(), ".claude", "skills", skill);
    if (existsSync(source)) cpSync(source, join(dir, ".claude", "skills", skill), { recursive: true });
  }
  const sourceDurationS = prepared.facts.durationS ?? post.duration_s ?? 0;
  writeFileSync(join(dir, "brief.md"), buildRecreateBrief(await collectInputs(db, config, post, sourceDurationS, postDir)));
  return { dir, sourceDurationS };
}

export const SERVICE_MODULES = join(REPO_ROOT, "service", "node_modules");
export const HYPERFRAMES_BIN = join(SERVICE_MODULES, ".bin", "hyperframes");
export const HYPERFRAMES_ENV = { HYPERFRAMES_TELEMETRY: "0", HYPERFRAMES_SKIP_SKILLS: "1", DO_NOT_TRACK: "1" };

async function initHyperframes(dir: string): Promise<void> {
  await execFileAsync(HYPERFRAMES_BIN, ["init", ".", "--non-interactive", "--resolution", "portrait", "--skip-transcribe"], { cwd: dir, timeout: 120_000, env: { ...process.env, ...HYPERFRAMES_ENV } });
  // `npx hyperframes …` inside the workspace resolves to the pinned local package instead of the registry.
  symlinkSync(SERVICE_MODULES, join(dir, "node_modules"), "dir");
}

/** First Simplified Chinese text field of an assessment item, whatever its exact key. */
function zhText(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const record = item as Record<string, unknown>;
  const text = Object.entries(record).find(([key, value]) => key.endsWith("_zh") && typeof value === "string")?.[1] as string | undefined;
  const id = typeof record.pattern_id === "string" ? `${record.pattern_id}: ` : "";
  return text ? `${id}${text}` : "";
}

async function collectInputs(
  db: ContentLabDatabase,
  config: Partial<Pick<ServiceConfig, "whisperModel">>,
  post: WorkspacePost,
  durationS: number,
  postDir: string,
): Promise<RecreateInputs> {
  const feature = db.prepare("SELECT analysis_json FROM post_features WHERE post_id=? ORDER BY version DESC LIMIT 1").get(post.id) as { analysis_json: string } | undefined;
  const analysis = feature ? JSON.parse(feature.analysis_json) as { script?: Array<Record<string, unknown>> } : {};
  const assessmentRow = db.prepare("SELECT band, inputs_json FROM predictions WHERE post_id=? AND id LIKE 'assess-%' ORDER BY made_at DESC LIMIT 1").get(post.id) as { band: string; inputs_json: string } | undefined;
  const assessment = assessmentRow ? JSON.parse(assessmentRow.inputs_json) as { suggestions?: unknown[]; missing_patterns?: unknown[]; anti_patterns_hit?: unknown[] } : null;
  const list = (items: unknown[] | undefined) => (items ?? []).map((item) => {
    const record = item as Record<string, unknown>;
    return typeof record?.change_zh === "string" ? record.change_zh : zhText(item);
  }).filter(Boolean);
  const playbook = post.market ? latestPlaybook(db, post.market) : null;
  let transcript: RecreateInputs["transcript"] = null;
  if (config.whisperModel) {
    const result = await transcribePost(postDir, config.whisperModel, MARKET_LANGUAGES[post.market?.toUpperCase() ?? ""] ?? []).catch(() => null);
    if (result) transcript = { language: result.language ?? "unknown", segments: result.segments.map((segment) => ({ start: segment.startS, end: segment.endS, text: segment.text })) };
  }
  return {
    postId: post.id, market: post.market ?? "", durationS, caption: post.caption,
    transcript, script: analysis.script ?? [],
    assessment: assessmentRow ? { band: assessmentRow.band, suggestions: list(assessment?.suggestions), missing: list(assessment?.missing_patterns), antiPatterns: list(assessment?.anti_patterns_hit) } : null,
    playbookSummary: playbook ? renderPlaybookMarkdown(playbook, "zh").slice(0, 6_000) : null,
    memories: ownerMemoryBlock(memoriesFor(db, { market: post.market, postId: post.id })),
  };
}
