import { DatabaseSync } from "node:sqlite";

import { docSections, marketFromCell, parseDate } from "./doc-links.js";
import { TIKTOK_URL, type FeishuDocument } from "./docs.js";

const MAX_ROWS = 200;
const MAX_CELL = 500;
// SQLite authorizer action codes: allow reading and calling functions, refuse everything else (ATTACH, writes, PRAGMA).
const SQLITE_READ = 20, SQLITE_SELECT = 21, SQLITE_FUNCTION = 31, SQLITE_RECURSIVE = 33, SQLITE_OK = 0, SQLITE_DENY = 1;

/** Unique, non-empty column names from a header row. */
function columnNames(header: string[], width: number): string[] {
  const used = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const base = (header[index] ?? "").trim().replace(/\s+/g, " ") || `col_${index + 1}`;
    const count = (used.get(base.toLowerCase()) ?? 0) + 1;
    used.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base}_${count}`;
  });
}
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Load every tab of a document into a throwaway in-memory database: table t1, t2… per tab with the sheet's own
 * column names, plus `_row` (row number) and `_links` (the TikTok links found in the row). Two helper functions:
 * to_date(text) gives YYYY-MM-DD from spreadsheet date numbers or written dates, market_of(text) gives a market code.
 */
export function loadDocTables(doc: FeishuDocument): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.function("to_date", { deterministic: true }, (value: unknown) => {
    const time = parseDate(value === null || value === undefined ? undefined : String(value));
    return time === null ? null : new Date(time).toISOString().slice(0, 10);
  });
  db.function("market_of", { deterministic: true }, (value: unknown) => marketFromCell(value === null || value === undefined ? undefined : String(value)));
  db.exec("CREATE TABLE _tabs (table_name TEXT, tab TEXT, rows INTEGER, columns TEXT)");
  docSections(doc).forEach((section, index) => {
    const table = `t${index + 1}`;
    const width = Math.max(section.header.length, ...section.rows.map((row) => row.length), 1);
    const columns = [...columnNames(section.header, width), "_row", "_links"];
    db.exec(`CREATE TABLE ${table} (${columns.map((name) => `${quote(name)} TEXT`).join(", ")})`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(", ")})`);
    section.rows.forEach((row, rowIndex) => {
      const cells = Array.from({ length: width }, (_, cell) => row[cell] ?? null);
      insert.run(...cells, String(rowIndex + 1), (row.join("\t").match(TIKTOK_URL) ?? []).join(" ") || null);
    });
    db.prepare("INSERT INTO _tabs VALUES (?, ?, ?, ?)").run(table, section.title, section.rows.length, JSON.stringify(columns));
  });
  const authorize = (db as unknown as { setAuthorizer?: (callback: (action: number) => number) => void }).setAuthorizer;
  if (typeof authorize !== "function") { db.close(); throw new Error("This Node.js has no SQLite authorizer; sheet queries are disabled"); }
  authorize.call(db, (action) => [SQLITE_READ, SQLITE_SELECT, SQLITE_FUNCTION, SQLITE_RECURSIVE].includes(action) ? SQLITE_OK : SQLITE_DENY);
  return db;
}

export function describeDocTables(db: DatabaseSync): Array<{ table: string; tab: string; rows: number; columns: string[] }> {
  return (db.prepare("SELECT table_name, tab, rows, columns FROM _tabs ORDER BY rowid").all() as Array<{ table_name: string; tab: string; rows: number; columns: string }>).map((row) => ({
    table: row.table_name, tab: row.tab, rows: Number(row.rows), columns: JSON.parse(row.columns) as string[],
  }));
}

/** One SELECT (or WITH … SELECT) over the loaded tabs; long cells are shortened and at most `limit` rows come back. */
export function queryDocTables(db: DatabaseSync, sql: string, limit = MAX_ROWS): { rows: Array<Record<string, unknown>>; count: number; truncated: boolean } {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("Only a SELECT (or WITH … SELECT) query is allowed");
  if (/;\s*\S/.test(sql)) throw new Error("Only a single statement is allowed");
  const all = db.prepare(sql).all() as Array<Record<string, unknown>>;
  const rows = all.slice(0, limit).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" && value.length > MAX_CELL ? `${value.slice(0, MAX_CELL)}…` : value])));
  return { rows, count: all.length, truncated: all.length > limit };
}

/** Every row of a query, for program-side binding: no row cap, cells untouched. */
export function queryAllDocRows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error("Only a single SELECT (or WITH … SELECT) query is allowed");
  return db.prepare(sql).all() as Array<Record<string, unknown>>;
}
