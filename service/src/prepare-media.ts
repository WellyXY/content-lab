import { preparePostMedia } from "./analyzer/codex.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

const args = process.argv.slice(2);
const ids: string[] = [];
let allExisting = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--all-existing") allExisting = true;
  else if (arg === "--post-id" && args[index + 1] && !args[index + 1]?.startsWith("--")) ids.push(args[++index]!);
  else throw new Error("Usage: tsx src/prepare-media.ts --post-id <local-id> [--post-id <local-id>…] OR --all-existing");
}
if ((allExisting && ids.length > 0) || (!allExisting && ids.length === 0)) throw new Error("Choose explicit --post-id arguments or --all-existing");

const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  const selected = allExisting
    ? (db.prepare("SELECT id FROM posts ORDER BY bound_at, id").all() as { id: string }[]).map((row) => row.id)
    : [...new Set(ids)];
  // Resolve every supplied target before downloading or uploading anything.
  for (const id of selected) if (!db.prepare("SELECT 1 FROM posts WHERE id=?").get(id)) throw new Error(`Unknown post ${id}`);
  let succeeded = 0;
  let failed = 0;
  for (const id of selected) {
    try {
      const result = await preparePostMedia(db, config, id);
      succeeded += 1;
      console.log(JSON.stringify({ postId: result.postId, externalPostId: result.externalPostId, keyframes: result.publicFrames, count: result.frames.length, status: "ready" }));
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ postId: id, status: "failed", error: error instanceof Error ? error.message : "Media preparation failed" }));
    }
  }
  console.log(JSON.stringify({ selected: selected.length, succeeded, failed }));
  if (failed > 0) process.exitCode = 1;
} finally {
  db.close();
}
