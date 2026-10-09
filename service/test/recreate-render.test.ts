import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderRecreation, verifyRendition } from "../src/recreate/render.js";

const make = (out: string, size: string, seconds: number, audio = true) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${size}:d=${seconds}`, ...(audio ? ["-f", "lavfi", "-i", `sine=d=${seconds}`, "-shortest"] : []), "-pix_fmt", "yuv420p", out]);

describe("rendition checks", () => {
  it("accepts a 1080x1920 clip with audio within the source length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-"));
    const out = join(dir, "ok.mp4"); make(out, "1080x1920", 6);
    await expect(verifyRendition(out, 8)).resolves.toMatchObject({ durationS: expect.any(Number) });
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects wrong size, silence, too short and too long", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-"));
    const wide = join(dir, "w.mp4"); make(wide, "1920x1080", 6);
    const mute = join(dir, "m.mp4"); make(mute, "1080x1920", 6, false);
    const short = join(dir, "s.mp4"); make(short, "1080x1920", 3);
    await expect(verifyRendition(wide, 8)).rejects.toThrow(/1080x1920/);
    await expect(verifyRendition(mute, 8)).rejects.toThrow(/audio/);
    await expect(verifyRendition(short, 8)).rejects.toThrow(/at least 5/);
    const long = join(dir, "l.mp4"); make(long, "1080x1920", 6);
    await expect(verifyRendition(long, 4)).rejects.toThrow(/longer than the source/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders through the injected renderer and writes a cover", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-"));
    const result = await renderRecreation(dir, 8, { render: async (_d, out) => make(out, "1080x1920", 6) });
    expect(result.coverPath.endsWith("cover.jpg")).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
