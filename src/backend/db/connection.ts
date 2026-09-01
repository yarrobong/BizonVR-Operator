import Database from "better-sqlite3";
import { applyMigrations } from "./migrations";
import type { SqliteDatabase } from "./types";

export function createDatabase(filename = ":memory:"): SqliteDatabase {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  applyMigrations(db);
  return db;
}
