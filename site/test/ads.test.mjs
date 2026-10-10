import assert from "node:assert/strict";
import test from "node:test";
import { adsSortValue, formatMoney, formatPercentChange, marketAdsSql, rowToMarketAds } from "../lib/ads.ts";

test("money keeps a $ and truncates to two decimals; missing is a dash, not zero", () => {
  assert.equal(formatMoney(1234.5678), "$1,234.56");
  assert.equal(formatMoney(0.4299), "$0.42");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(null), "—");
});

test("percentage change uses full precision and is undefined without a prior value", () => {
  assert.equal(formatPercentChange(0.4, 0.5), "-20.0%");
  assert.equal(formatPercentChange(150, 100), "+50.0%");
  assert.equal(formatPercentChange(10, 0), null);
  assert.equal(formatPercentChange(null, 5), null);
});

test("ads sort puts promoted posts first and never treats missing cost as cheapest", () => {
  const promoted = { ads: { lifetime: { spend: 10, registrations: 20, cpr: 0.5 } } };
  const organic = { ads: null };
  assert.equal(adsSortValue(promoted, "spend"), 10);
  assert.equal(adsSortValue(organic, "spend"), Number.NEGATIVE_INFINITY);
  assert.equal(adsSortValue(promoted, "cpr"), -0.5);
  assert.equal(adsSortValue({ ads: { lifetime: { spend: 3, registrations: 0, cpr: null } } }, "cpr"), Number.NEGATIVE_INFINITY);
});

test("market totals divide summed spend by summed registrations", () => {
  const row = { market: "VN", promoted_posts: 3, active_posts: 2, spend_7d: 60, registrations_7d: 150, installs_7d: 300, impressions_7d: 40000, spend_prev_7d: 40, registrations_prev_7d: 80, installs_prev_7d: 100, impressions_prev_7d: 20000 };
  const result = rowToMarketAds(row);
  assert.equal(result.last7d.cpr, 0.4);
  assert.equal(result.prev7d.cpr, 0.5);
  assert.equal(result.last7d.cpm, 1.5);
  assert.equal(result.prev7d.cpi, 0.4);
  assert.match(marketAdsSql, /json_extract\(ads_json, '\$\.last7d\.spend'\)/);
});

import { readFileSync } from "node:fs";

test("IQ is a market with Baghdad time", () => {
  // content-lab.ts has extensionless imports that node:test cannot resolve, so check its market list as text.
  const source = readFileSync(new URL("../lib/content-lab.ts", import.meta.url), "utf8");
  assert.match(source, /\{ code: "IQ", label: "伊拉克", labelEn: "Iraq", timezone: "UTC\+3" \}/);
});
