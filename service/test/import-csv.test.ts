import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { enqueueCsvBindings, parseCsvBindings } from "../src/import-csv.js";

describe("trusted local CSV URL import", () => {
  it("parses Excel-style CSV, deduplicates URL tracking variants, and ignores old metrics", () => {
    const result = parseCsvBindings('\uFEFFurl,market,project_tag,source,views\r\nhttps://www.tiktok.com/@a/video/7412345678901234567,VN,"project, one",https://github.com/example/source,999999\r\nhttps://www.tiktok.com/@a/video/7412345678901234567?x=1,VN,duplicate,,\r\n', "source.csv");
    expect(result.duplicateCount).toBe(1);
    expect(result.bindings).toEqual([{
      url: "https://www.tiktok.com/@a/video/7412345678901234567", market: "VN", projectTag: "project, one",
      boundBy: "csv:source.csv:row-2:https://github.com/example/source",
    }]);
  });

  it("rejects a whole manifest when a row is invalid", () => {
    expect(() => parseCsvBindings("url\nhttps://www.tiktok.com/@a/video/7412345678901234567\nhttps://example.com/video/1", "source.csv")).toThrow(/row 3/);
    expect(() => parseCsvBindings("url\n\"unclosed", "source.csv")).toThrow(/unclosed/);
  });

  it("queues idempotently without inventing posts or current metric snapshots", () => {
    const db = openDatabase(":memory:");
    const { bindings } = parseCsvBindings("url,views\nhttps://www.tiktok.com/@a/video/7412345678901234567,999999", "source.csv");
    const first = enqueueCsvBindings(db, bindings);
    expect(enqueueCsvBindings(db, bindings)).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM posts").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM metric_snapshots").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({ count: 1 });
    db.close();
  });
});
