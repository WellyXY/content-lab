import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { upsertPost } from "../src/collector.js";
import { copyPrompt } from "../src/copy/generate.js";
import { validateLayout } from "../src/copy/layout.js";
import { compositeOverlays, overlayMask } from "../src/copy/overlay.js";
import { readRgb, writeJpeg, type Rgb } from "../src/copy/pixels.js";
import { runImageCopy, type ImageCopyNotes } from "../src/copy/run.js";
import { openDatabase } from "../src/db/database.js";

/** A dark photo with a yellow "letter" block outlined in brown, and a white UI card. */
function sample(width = 100, height = 80): Rgb {
  const data = Buffer.alloc(width * height * 3, 20);
  const paint = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: [number, number, number]) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const i = (y * width + x) * 3; data[i] = r; data[i + 1] = g; data[i + 2] = b; }
  };
  paint(8, 8, 32, 22, [110, 60, 20]);   // outline
  paint(11, 11, 29, 19, [245, 200, 60]); // letter fill
  paint(50, 40, 90, 70, [250, 250, 250]); // UI card
  return { width, height, data };
}

describe("text and UI copied from the original", () => {
  it("keeps letters with their outline and whole UI boxes, and nothing else", () => {
    const source = sample();
    const mask = overlayMask(source, [{ type: "text", box: [0.05, 0.05, 0.4, 0.3], fill: "#f5c83c" }, { type: "ui", box: [0.5, 0.5, 0.9, 0.875] }]);
    const at = (x: number, y: number) => mask[y * source.width + x];
    expect(at(20, 15)).toBe(1); // letter
    expect(at(9, 9)).toBe(1); // outline next to it
    expect(at(60, 50)).toBe(1); // UI
    expect(at(45, 15)).toBe(0); // photo outside the boxes
    expect(at(3, 3)).toBe(0); // photo beyond the outline
    const base: Rgb = { width: 100, height: 80, data: Buffer.alloc(100 * 80 * 3, 128) };
    const out = compositeOverlays(base, source, mask);
    expect([...out.data.subarray((15 * 100 + 20) * 3, (15 * 100 + 20) * 3 + 3)]).toEqual([245, 200, 60]);
    expect(out.data[(3 * 100 + 3) * 3]).toBe(128);
  });

  it("checks the layout the model returns", () => {
    const photo = { index: 1, kind: "photo", scene: "selfie", replace: "grey crop top", overlays: [{ type: "text", box: [0.1, 0.1, 0.5, 0.2], fill: "#ffffff" }, { type: "ui", box: [0.2, 0.5, 0.8, 0.9], fill: "" }] };
    expect(validateLayout({ images: [photo, { index: 2, kind: "screenshot", scene: "", replace: "", overlays: [] }] }, 2)[0]!.overlays).toHaveLength(2);
    expect(() => validateLayout({ images: [photo] }, 2)).toThrow(/exactly 2/);
    expect(() => validateLayout({ images: [{ ...photo, overlays: [{ type: "ui", box: [0.5, 0.5, 0.2, 0.9], fill: "" }] }] }, 1)).toThrow(/x1<=x0/);
    expect(() => validateLayout({ images: [{ ...photo, overlays: [{ type: "text", box: [0.1, 0.1, 0.2, 0.2], fill: "yellow" }] }] }, 1)).toThrow(/#rrggbb/);
  });

  it("asks for a local creator of the post's market and no overlaid text", () => {
    const prompt = copyPrompt({ market: "TH", scene: "one-arm selfie, winking", replace: "grey ribbed crop top and shorts", width: 1080, height: 1920, variant: 2 });
    expect(prompt).toContain("Do not reuse any of this from the original: grey ribbed crop top and shorts");
    expect(prompt).toContain("Thai creator");
    expect(prompt).toContain("one-arm selfie, winking");
    expect(prompt).toMatch(/NO overlaid text/);
    expect(prompt).toContain("variant 2");
  });
});

describe("copying a carousel", () => {
  it("reshoots photos, keeps screenshots, lays the original text back and uploads every image", async () => {
    const root = mkdtempSync(join(tmpdir(), "image-copy-"));
    const mediaDir = join(root, "media");
    const db = openDatabase(":memory:");
    const post = upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7400000000000000009", url: "https://www.tiktok.com/@a/photo/7400000000000000009", authorId: "u", authorHandle: "a", caption: "", type: "photo", durationS: null, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "PH", projectTag: null, boundBy: null });
    mkdirSync(join(mediaDir, post.id), { recursive: true });
    await writeJpeg(join(mediaDir, post.id, "img-01.jpg"), sample());
    await writeJpeg(join(mediaDir, post.id, "img-02.jpg"), sample());
    const uploads: string[] = [];
    let prompts = 0;
    await runImageCopy(db, { mediaDir, codexModel: null } as never, { recreationId: "rc1", sitePostId: post.id }, {
      analyze: async () => [
        { index: 1, kind: "photo", scene: "dark selfie", replace: "black hoodie, bedroom", overlays: [{ type: "text", box: [0.05, 0.05, 0.4, 0.3], fill: "#f5c83c" }] },
        { index: 2, kind: "screenshot", scene: "", replace: "", overlays: [] },
      ],
      generate: async (dir, _source, prompt) => {
        prompts += 1;
        expect(prompt).toContain("Filipino creator");
        if (prompt.includes("variant 2")) return null; // the image tool declined this one
        mkdirSync(dir, { recursive: true });
        const out = join(dir, "base.png");
        execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=200x160", "-frames:v", "1", out]);
        return out;
      },
      upload: async (_id, filename) => { uploads.push(filename); return `/media/recreations/rc1/${filename}`; },
    });
    expect(prompts).toBe(2);
    expect(uploads.sort()).toEqual(["img-01-0.jpg", "img-01-1.jpg", "img-02-0.jpg"]);
    const row = db.prepare("SELECT status, notes_json FROM recreations WHERE id='rc1'").get() as { status: string; notes_json: string };
    expect(row.status).toBe("complete");
    const notes = JSON.parse(row.notes_json) as ImageCopyNotes;
    expect(notes.images).toEqual([
      { index: 1, kept: false, original: "/media/recreations/rc1/img-01-0.jpg", variants: ["/media/recreations/rc1/img-01-1.jpg"], failed: 1 },
      { index: 2, kept: true, original: "/media/recreations/rc1/img-02-0.jpg", variants: [], failed: 0 },
    ]);
    // The generated grey photo now carries the original letter, at the original size.
    const result = await readRgb(join(root, "recreate", "rc1", "img-01-1.jpg"));
    expect([result.width, result.height]).toEqual([100, 80]);
    const i = (15 * 100 + 20) * 3;
    expect(result.data[i]!).toBeGreaterThan(200);
    expect(result.data[(3 * 100 + 3) * 3]!).toBeGreaterThan(100);
    db.close();
  });
});

import { carouselSlideshow, slideSeconds } from "../src/recreate/workspace.js";
import { buildRecreateBrief } from "../src/recreate/brief.js";

describe("recreating a carousel as a video", () => {
  it("turns the images into a 1080x1920 slideshow with an audio track, at least 6 seconds long", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slideshow-"));
    const images = [join(dir, "a.jpg"), join(dir, "b.jpg")];
    for (const image of images) await writeJpeg(image, sample());
    await carouselSlideshow(images, join(dir, "source.mp4"));
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", join(dir, "source.mp4")], { encoding: "utf8" })) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } };
    expect(info.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
    expect(info.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
    expect(Number(info.format.duration)).toBeCloseTo(6, 0);
    expect(slideSeconds(1)).toBe(6);
    expect(slideSeconds(5)).toBe(3);
    const brief = buildRecreateBrief({ postId: "p", market: "PH", durationS: 6, caption: null, transcript: null, script: [], assessment: null, playbookSummary: null, memories: "", carousel: { images: 2, secondsEach: 3 } });
    expect(brief).toContain("photo carousel");
  });
});
