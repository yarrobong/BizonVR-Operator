import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { applyMigrations, createDatabase } from "../src/backend/database";

const migrationsDir = path.resolve("db/migrations");

describe("SQLite migration safety", () => {
  it("migrates a fresh database to the latest version", () => {
    const db = createDatabase(":memory:");
    assert.equal((db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0007_agent_auth.sql'`).get() as unknown) !== undefined, true);
    assert.equal((db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>).some((row) => row.name === "agent_token_hash"), true);
  });

  it("upgrades legacy maintenance and charging statuses without losing rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(path.join(migrationsDir, "0001_initial.sql"), "utf8"));
    db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    db.prepare(`INSERT INTO schema_migrations(version) VALUES ('0001_initial.sql')`).run();
    db.prepare(`INSERT INTO organizations(name, slug) VALUES ('Legacy', 'legacy')`).run();
    db.prepare(`INSERT INTO clubs(organization_id, name, slug) VALUES (1, 'Legacy Club', 'legacy-club')`).run();
    db.prepare(`INSERT INTO devices(club_id, name, serial_number, status) VALUES (1, 'Maintenance Quest', 'LEGACY-M', 'maintenance_required')`).run();
    db.prepare(`INSERT INTO devices(club_id, name, serial_number, status) VALUES (1, 'Charging Quest', 'LEGACY-C', 'charging_required')`).run();
    applyMigrations(db, migrationsDir);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM devices WHERE status IN ('maintenance_required', 'charging_required')`).get() as { count: number }).count, 2);
  });

  it("rolls back a failing migration and does not record it as applied", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-migrations-"));
    const db = new Database(":memory:");
    try {
      fs.writeFileSync(path.join(root, "0001_initial.sql"), "CREATE TABLE should_rollback (id INTEGER); THIS IS INVALID;");
      assert.throws(() => applyMigrations(db, root));
      assert.equal((db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0001_initial.sql'`).get() as unknown) !== undefined, false);
      assert.equal((db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'should_rollback'`).get() as unknown) !== undefined, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
