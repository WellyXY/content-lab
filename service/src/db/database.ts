import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrations.js";

export type ContentLabDatabase = DatabaseSync;

export function openDatabase(filename: string): ContentLabDatabase {
  const target = filename === ":memory:" ? filename : resolve(filename);
  if (target !== ":memory:") mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target, { timeout: 5_000 });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}
