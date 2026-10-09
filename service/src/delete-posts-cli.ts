import { deletePosts } from "./admin/delete-posts.js";
import { resolvePost } from "./agent/tools.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { normalizeTikTokUrl } from "./domain/tiktok-url.js";

/**
 * npm run delete-posts -- [--dry-run] <post id | TikTok URL> ...
 * Removes local posts (or queued links that never became posts) and queues their removal from the Site.
 */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const refs = args.filter((arg) => arg !== "--dry-run");
if (refs.length === 0) throw new Error("usage: npm run delete-posts -- [--dry-run] <post id | TikTok URL> ...");
const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  const postIds: string[] = [];
  const urls: string[] = [];
  for (const ref of refs) {
    const id = resolvePost(db, ref);
    if (id) postIds.push(id);
    else urls.push(normalizeTikTokUrl(ref));
  }
  if (dryRun) console.log(JSON.stringify({ postIds, urls }, null, 2));
  else {
    const deleted = deletePosts(db, { postIds, urls }, config.mediaDir);
    console.log(JSON.stringify({ deleted: deleted.length, items: deleted, site: config.siteDeleteSync ? "queued for the next sync" : "queued; sent after SITE_DELETE_SYNC=1 is set for the Site release" }, null, 2));
  }
} finally {
  db.close();
}
