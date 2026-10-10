import { runProxyCall } from "./ads/proxy.js";
import { runAdsSync } from "./ads/sync.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

/** npm run ads [-- --max-calls N]: link Spark Ads to tracked posts and refresh their delivery metrics now. */
const args = process.argv.slice(2);
const maxIndex = args.indexOf("--max-calls");
const maxCalls = maxIndex >= 0 ? Number(args[maxIndex + 1]) : undefined;
const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  const result = await runAdsSync(db, { call: (call) => runProxyCall(call, { model: config.adsModel }) }, new Date(), maxCalls ? { maxCalls } : {});
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
