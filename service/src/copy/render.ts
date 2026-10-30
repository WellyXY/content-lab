import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import puppeteer from "puppeteer-core";

/** The newest Chrome headless shell that HyperFrames installed. */
export function chromePath(): string {
  const root = join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  const builds = existsSync(root) ? readdirSync(root).sort().reverse() : [];
  for (const build of builds) {
    const dir = join(root, build);
    const sub = readdirSync(dir).find((name) => name.startsWith("chrome-headless-shell"));
    const binary = sub ? join(dir, sub, "chrome-headless-shell") : "";
    if (binary && existsSync(binary)) return binary;
  }
  throw new Error("Chrome headless shell is not installed (run any HyperFrames render once)");
}

/** Render a local HTML page to a PNG of exactly width x height; transparent where the page has no background. */
export async function renderHtml(html: string, output: string, width: number, height: number): Promise<void> {
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.screenshot({ path: output as `${string}.png`, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}

/** The same renderer as a script the text session can run inside its folder to check its own work. */
export function renderScript(): string {
  return `import puppeteer from ${JSON.stringify(import.meta.resolve("puppeteer-core"))};
const [html, out, width, height] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: ${JSON.stringify(chromePath())}, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: Number(width), height: Number(height), deviceScaleFactor: 1 });
await page.goto("file://" + process.cwd() + "/" + html, { waitUntil: "networkidle0" });
await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: Number(width), height: Number(height) } });
await browser.close();
`;
}
