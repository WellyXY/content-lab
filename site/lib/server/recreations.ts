import type { Recreation } from "@/lib/content-lab";

// Kept free of runtime imports so node:test can load it without the Workers runtime.
export const RECREATIONS_PER_POST = 2;
export const MAX_RECREATION_BYTES = 50 * 1024 * 1024;

export function recreationKey(id: string, filename: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !["video.mp4", "cover.jpg"].includes(filename)) return null;
  return `recreations/${id}/${filename}`;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

export function rowToRecreation(row: Record<string, unknown>): Recreation {
  let notes: Recreation["notes"] = null;
  if (typeof row.notes_json === "string") {
    try {
      const parsed = JSON.parse(row.notes_json) as Recreation["notes"];
      if (parsed && typeof parsed.summary_zh === "string" && Array.isArray(parsed.changes)) notes = parsed;
    } catch { /* unreadable notes are shown as none */ }
  }
  return {
    id: String(row.id), status: String(row.status) as Recreation["status"], notes,
    videoUrl: text(row.video_url), coverUrl: text(row.cover_url), error: text(row.error),
    counts: Number(row.counts ?? 1), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
