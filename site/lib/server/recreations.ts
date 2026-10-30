import type { Recreation } from "@/lib/content-lab";

// Kept free of runtime imports so node:test can load it without the Workers runtime.
export const RECREATIONS_PER_POST = 2;
export const MAX_RECREATION_BYTES = 50 * 1024 * 1024;

export function recreationKey(id: string, filename: string): string | null {
  // Videos: video.mp4 and cover.jpg. Carousel copies: img-NN-V.jpg (V 0 is the original, 1+ the generated versions).
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !(["video.mp4", "cover.jpg"].includes(filename) || /^img-\d{2}-\d\.jpg$/.test(filename))) return null;
  return `recreations/${id}/${filename}`;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

export function rowToRecreation(row: Record<string, unknown>): Recreation {
  let notes: Recreation["notes"] = null;
  if (typeof row.notes_json === "string") {
    try {
      const parsed = JSON.parse(row.notes_json) as Recreation["notes"];
      if (parsed && typeof parsed.summary_zh === "string" && Array.isArray(parsed.changes)) notes = { ...parsed, ...(Array.isArray(parsed.images) ? { images: parsed.images } : {}) };
    } catch { /* unreadable notes are shown as none */ }
  }
  return {
    id: String(row.id), status: String(row.status) as Recreation["status"], notes,
    videoUrl: text(row.video_url), coverUrl: text(row.cover_url), error: text(row.error),
    counts: Number(row.counts ?? 1), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

/** Queued or running recreations across the whole site; the Mac runs one at a time, so a script cannot fill hours of queue. */
export const ACTIVE_RECREATIONS_LIMIT = 5;

/** Binds: id, post_id, created_at, updated_at, post_id (for the per-post count), per-post cap, site-wide active cap. */
export const insertRecreationSql = `INSERT INTO recreations (id, post_id, status, counts, created_at, updated_at)
  SELECT ?, ?, 'queued', 1, ?, ?
  WHERE (SELECT COALESCE(SUM(counts), 0) FROM recreations WHERE post_id = ?) < ?
    AND (SELECT COUNT(*) FROM recreations WHERE status IN ('queued', 'preparing', 'designing', 'rendering')) < ?`;

/** Browsers mark requests from other sites; scripts without the header are held back by the active limit. */
export function isCrossSiteRequest(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}
