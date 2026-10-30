import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where each market's creators live, so the copy reads as a local post. */
export const MARKET_PLACES: Record<string, string> = {
  ID: "an Indonesian creator in Indonesia (for example Jakarta or Bandung)", VN: "a Vietnamese creator in Vietnam (for example Ho Chi Minh City or Hanoi)",
  TR: "a Turkish creator in Turkey (for example Istanbul or Ankara)", GCC: "an Arab creator in the Gulf (for example Riyadh or Dubai), dressed as is usual there",
  TH: "a Thai creator in Thailand (for example Bangkok or Chiang Mai)", IQ: "an Iraqi creator in Iraq (for example Baghdad), dressed as is usual there",
  PH: "a Filipino creator in the Philippines (for example Metro Manila)",
};

export function copyPrompt(input: { market: string | null; scene: string; width: number; height: number; variant: number }): string {
  const place = MARKET_PLACES[input.market ?? ""] ?? "a different creator";
  return [
    `Recreate the attached source.jpg as a new photo by ${place}. Use the image generation tool and save the result in this directory as base.png.`,
    `Keep: the same camera angle, framing, crop and subject placement, the same pose and gesture, the same emotion, lighting and colour mood, and the same story. The original shot: ${input.scene}`,
    "Replace: the person or people (different faces and hairstyles), their clothing and accessories, and the location (a different, locally typical setting). Logos or app elements that are physically in the original scene may stay; add none of your own.",
    `The image must contain NO overlaid text, captions, emoji, stickers, app pop-ups or watermarks: the original ones are laid back on top by a program afterwards, so keep the areas where they were simple. Aim for ${input.width}x${input.height} pixels (the program scales and crops to that size).`,
    `It must look like a real, casual smartphone photo a young creator would post, not an ad or a studio shot. All people are adults, fully clothed, non-sexual. This is variant ${input.variant}: make it clearly different from other variants in person, outfit and place.`,
    "If the image tool declines a request, rephrase it in neutral terms and try again. Reply with only the file name.",
  ].join("\n");
}

const DISABLED = ["apps", "plugins", "hooks", "multi_agent", "computer_use", "browser_use"];

/** Run one Codex session that generates base.png in `dir` from source.jpg. Returns the image path, or null when Codex produced none. */
export async function generateWithCodex(dir: string, sourcePath: string, prompt: string, options: { model?: string | null; timeoutMs?: number } = {}): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.jpg");
  if (!existsSync(source)) copyFileSync(sourcePath, source);
  const args = ["exec", "--sandbox", "workspace-write", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never", "-C", dir, "-c", 'web_search="disabled"'];
  for (const feature of DISABLED) args.push("--disable", feature);
  if (options.model) args.push("--model", options.model);
  // --image is variadic: end option parsing so the prompt is not read as a file.
  args.push("--image", source, "--", prompt);
  const log = await new Promise<string>((resolve) => {
    // stdin must be closed, or `codex exec` waits for more input forever.
    const child = execFile("codex", args, { timeout: options.timeoutMs ?? 12 * 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => resolve(`${error ? `error: ${error.message.split("\n")[0]}\n` : ""}${stderr}\n${stdout}`));
    child.stdin?.end();
  });
  writeFileSync(join(dir, "codex.log"), log.slice(-200_000), { mode: 0o600 });
  if (/not logged in|login required|401 Unauthorized/i.test(log)) throw new Error("Codex is not signed in");
  const output = join(dir, "base.png");
  return existsSync(output) ? output : null;
}
