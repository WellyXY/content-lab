import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { ServiceConfig } from "../config.js";

const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_FRAMES = 12;

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Upload actual frame bytes before publishing their paths in a features event. */
export async function uploadKeyframes(
  config: Pick<ServiceConfig, "siteSyncUrl" | "siteSyncToken">,
  postId: string,
  frames: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (!config.siteSyncUrl || !config.siteSyncToken) throw new Error("Public keyframe delivery requires both SITE_SYNC_URL and SITE_SYNC_TOKEN");
  const destination = new URL(config.siteSyncUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname);
  if ((destination.protocol !== "https:" && !(local && destination.protocol === "http:")) || destination.username || destination.password || destination.search || destination.hash) {
    throw new Error("Public keyframe destination must be an HTTPS Site URL");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(postId)) throw new Error("Invalid keyframe post id");
  if (frames.length === 0 || frames.length > MAX_FRAMES) throw new Error("Keyframe delivery requires between 1 and 12 images");

  // Validate the complete batch before making any network request.
  const uploads = frames.map((frame) => {
    const file = basename(frame);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:jpe?g|png|webp)$/i.test(file)) throw new Error("Invalid keyframe filename");
    const stat = lstatSync(frame);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FRAME_BYTES) throw new Error(`Keyframe ${file} must be a nonempty image of at most 5 MiB`);
    const bytes = readFileSync(frame);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) throw new Error(`Keyframe ${file} exceeds the size limit`);
    const mime = imageMime(bytes);
    const extension = extname(file).toLowerCase();
    const expected = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    if (mime !== expected) throw new Error(`Keyframe ${file} is not a supported image matching its extension`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const filename = `${file.slice(0, -extension.length)}-${hash.slice(0, 16)}${extension}`;
    const path = `/media/${encodeURIComponent(postId)}/${encodeURIComponent(filename)}`;
    return { bytes, mime, hash, path };
  });

  const baseUrl = config.siteSyncUrl.replace(/\/$/, "");
  const paths: string[] = [];
  for (const upload of uploads) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(`${baseUrl}/api/local-worker${upload.path}`, {
        method: "PUT", redirect: "error", signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.siteSyncToken}`,
          "content-type": upload.mime,
          "idempotency-key": `media:${postId}:${upload.hash}`,
        },
        body: new Uint8Array(upload.bytes),
      });
      // Do not include response bodies or credentials in errors written to the job log.
      if (!response.ok) throw new Error(`Public keyframe upload returned HTTP ${response.status}`);
      await response.body?.cancel();
      paths.push(upload.path);
    } finally {
      clearTimeout(timer);
    }
  }
  return paths;
}
