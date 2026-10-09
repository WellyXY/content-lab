import { generatePlaybook, latestPlaybook, renderPlaybookMarkdown } from "./analyzer/playbook.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

/** `npm run playbook -- --market TR` prints the latest playbook; add `--generate` to build a new version now. */
const args = process.argv.slice(2);
const market = args[args.indexOf("--market") + 1]?.toUpperCase();
if (!market || args.indexOf("--market") < 0) throw new Error("Usage: npm run playbook -- --market TR [--generate]");
const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  const playbook = args.includes("--generate") ? await generatePlaybook(db, config, market) : latestPlaybook(db, market);
  console.log(playbook ? renderPlaybookMarkdown(playbook) : `${market} has no playbook yet.`);
} finally {
  db.close();
}
