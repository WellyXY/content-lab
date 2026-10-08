import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tagLabel, tagDimensionLabel, tagConfidenceLabel } from "../lib/tag-labels.ts";

const taxonomy = JSON.parse(readFileSync(new URL("../../docs/taxonomy/v3.json", import.meta.url), "utf8"));
let count = 0;
for (const [dimension, definition] of Object.entries(taxonomy.dimensions)) {
  assert.match(tagDimensionLabel(dimension), /[\u4e00-\u9fff]/, dimension);
  for (const value of Object.keys(definition.values)) {
    assert.match(tagLabel(value, dimension), /[\u4e00-\u9fff]/, `${dimension}.${value}`);
    count++;
  }
}
assert.equal(tagLabel(["notification", "app_badge"], "format_elements"), "手機通知、應用程式圖示／角標");
assert.equal(tagLabel("none", "cta"), "無行動呼籲");
assert.equal(tagLabel("none", "person_presence"), "無真人出鏡");
assert.equal(tagLabel("na", "product_timing"), "不適用");
assert.equal(tagLabel("contrast"), "對比反差");
assert.equal(tagLabel([]), "—");
assert.equal(tagLabel("future_value"), "future value");
assert.deepEqual(["high", "medium", "low"].map(tagConfidenceLabel), ["信心高", "信心中", "信心低"]);
console.log(`Chinese labels verified: ${Object.keys(taxonomy.dimensions).length} dimensions, ${count} values, multi-select and confidence labels.`);
