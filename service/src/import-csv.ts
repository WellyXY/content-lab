import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { openDatabase, type ContentLabDatabase } from "./db/database.js";
import { normalizeTikTokUrl } from "./domain/tiktok-url.js";
import { enqueueJob } from "./jobs/queue.js";

export interface CsvBinding {
  url: string;
  market: string | null;
  projectTag: string | null;
  boundBy: string;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = input.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (quoted || field.length === 0) quoted = !quoted;
      else throw new Error("CSV contains an unexpected quote");
    } else if (!quoted && (char === "," || char === "\r" || char === "\n")) {
      row.push(field);
      field = "";
      if (char !== ",") {
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
        if (char === "\r" && source[index + 1] === "\n") index += 1;
      }
    } else field += char;
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

export function parseCsvBindings(input: string, sourceName: string): { bindings: CsvBinding[]; duplicateCount: number } {
  const [headers, ...rows] = parseCsv(input);
  if (!headers) throw new Error("CSV is empty");
  const names = headers.map((header) => header.trim().toLowerCase());
  const urlIndex = names.findIndex((name) => ["url", "tiktok_url", "連結", "链接", "影片連結", "视频链接"].includes(name));
  if (urlIndex < 0) throw new Error("CSV must include a url column");
  const marketIndex = names.indexOf("market");
  const projectIndex = names.findIndex((name) => ["project_tag", "projecttag"].includes(name));
  const sourceIndex = names.indexOf("source");
  const result = new Map<string, CsvBinding>();
  let duplicateCount = 0;
  for (const [index, row] of rows.entries()) {
    const field = (column: number): string | null => column >= 0 ? row[column]?.trim() || null : null;
    const rawUrl = field(urlIndex);
    if (!rawUrl) throw new Error(`CSV row ${index + 2} is missing a TikTok URL`);
    let url: string;
    try { url = normalizeTikTokUrl(rawUrl); }
    catch (error) { throw new Error(`CSV row ${index + 2}: ${error instanceof Error ? error.message : String(error)}`); }
    if (result.has(url)) { duplicateCount += 1; continue; }
    result.set(url, {
      url, market: field(marketIndex), projectTag: field(projectIndex),
      boundBy: `csv:${basename(sourceName)}:row-${index + 2}${field(sourceIndex) ? `:${field(sourceIndex)}` : ""}`,
    });
  }
  if (result.size === 0) throw new Error("CSV contains no TikTok URLs");
  return { bindings: [...result.values()], duplicateCount };
}

export function enqueueCsvBindings(db: ContentLabDatabase, bindings: CsvBinding[]): Array<{ id: string; url: string; status: string }> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const jobs = bindings.map((binding) => {
      const job = enqueueJob(db, {
        kind: "ingest", payload: binding,
        idempotencyKey: `ingest:${createHash("sha256").update(binding.url).digest("hex")}`,
      });
      return { id: job.id, url: binding.url, status: job.status };
    });
    db.exec("COMMIT");
    return jobs;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filename = args.find((arg) => !arg.startsWith("--"));
  if (!filename || args.some((arg) => arg.startsWith("--") && !["--enqueue", "--dry-run"].includes(arg))) {
    throw new Error("Usage: npx tsx src/import-csv.ts <file.csv> [--dry-run | --enqueue]");
  }
  if (args.includes("--enqueue") && args.includes("--dry-run")) throw new Error("Choose --enqueue or --dry-run, not both");
  const parsed = parseCsvBindings(readFileSync(resolve(filename), "utf8"), filename);
  if (!args.includes("--enqueue")) {
    console.log(JSON.stringify({ dryRun: true, uniqueUrls: parsed.bindings.length, duplicateCount: parsed.duplicateCount, bindings: parsed.bindings }, null, 2));
    return;
  }
  const db = openDatabase(loadConfig().dbPath);
  try {
    const jobs = enqueueCsvBindings(db, parsed.bindings);
    console.log(JSON.stringify({ dryRun: false, uniqueUrls: parsed.bindings.length, duplicateCount: parsed.duplicateCount, jobs }, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
