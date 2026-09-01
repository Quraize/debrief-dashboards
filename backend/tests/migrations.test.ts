/**
 * Migration mechanics.
 *
 * MIGRATION_PLAN.md §8.7 requires migrations to be reversible and tested in both
 * directions. A down-migration that has never been executed is not a rollback
 * plan, it is a hope.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { loadMigrations, migrateUp, migrateDown } from "../src/db/migrate.js";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";

const reachable = await pgReachable();
requirePg(reachable);

describe("migration files", () => {
  const files = loadMigrations();

  it("every migration has a matching down file", () => {
    const missing = files.filter((m) => !m.down).map((m) => `${m.version}_${m.name}`);
    expect(missing, "migrations without a .down.sql").toEqual([]);
  });

  it("versions are unique and ordered", () => {
    const versions = files.map((f) => f.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it("no migration is empty", () => {
    for (const m of files) {
      expect(m.up.trim().length, `${m.version}_${m.name}.up.sql`).toBeGreaterThan(0);
      expect(m.down!.trim().length, `${m.version}_${m.name}.down.sql`).toBeGreaterThan(0);
    }
  });

  it("no migration hard-codes a password or token", () => {
    // scripts/bootstrap-roles.sql holds dev-only role passwords by design and is
    // deliberately not part of the migration sequence.
    for (const m of files) {
      expect(m.up, `${m.version}_${m.name}`).not.toMatch(/PASSWORD\s+'/i);
    }
  });
});

describe.skipIf(!reachable)("migrate up / down", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb("migrate"); });
  afterAll(async () => db?.drop());

  const tableCount = async () =>
    (await db.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
    )).rows[0]!.n;

  // Captured from the first successful run rather than hardcoded. A magic
  // number here means every new migration breaks this file for a reason that
  // has nothing to do with migrations working — which is exactly what happened
  // when 0005 and 0006 were added.
  let tablesAfterUp = 0;

  it("applies every migration on a fresh database", async () => {
    tablesAfterUp = await tableCount();
    expect(tablesAfterUp, "migrations should create tables").toBeGreaterThan(0);
    // Sanity check against the registry the API serves, so a table added to one
    // and not the other is caught here.
    const { ENTITIES } = await import("../src/entities/registry.js");
    expect(tablesAfterUp).toBeGreaterThanOrEqual(Object.keys(ENTITIES).length);
  });

  it("is a no-op when already up to date", async () => {
    expect(await migrateUp(db.owner, () => {})).toBe(0);
  });

  it("reverts everything cleanly, leaving only the registry", async () => {
    const files = loadMigrations();
    await migrateDown(db.owner, files.length, () => {});
    expect(await tableCount()).toBe(0);

    const { rows } = await db.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'allied%'`);
    expect(rows[0]!.n, "helper functions should be dropped too").toBe(0);
  });

  it("re-applies from scratch after a full revert", async () => {
    const files = loadMigrations();
    expect(await migrateUp(db.owner, () => {})).toBe(files.length);
    // The same schema comes back — that is what makes the down migrations a
    // rollback plan rather than a hope.
    expect(await tableCount()).toBe(tablesAfterUp);
  });

  it("refuses to run when an applied migration has been edited", async () => {
    // Silent schema drift between the repo and the database is worse than a
    // failed deploy, so the runner treats a changed checksum as fatal.
    await db.owner.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1`);
    await expect(migrateUp(db.owner, () => {})).rejects.toThrow(/modified after being applied/i);
    // restore so later assertions in this file are not affected
    const original = loadMigrations().find((m) => m.version === 1)!;
    await db.owner.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, [original.checksum]);
  });

  it("refuses to run when an applied migration has vanished from disk", async () => {
    await db.owner.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES (9999, 'ghost', 'x')`);
    await expect(migrateUp(db.owner, () => {})).rejects.toThrow(/missing from/i);
    await db.owner.query(`DELETE FROM schema_migrations WHERE version = 9999`);
  });
});

describe.skipIf(!reachable)("concurrency", () => {
  it("serialises two simultaneous migration runs with an advisory lock", async () => {
    // Two deploys racing through the same DDL is a real production scenario;
    // the second must wait, not fail or double-apply.
    const db = await createTestDb("lock");
    try {
      await migrateDown(db.owner, loadMigrations().length, () => {});
      const results = await Promise.all([
        migrateUp(db.owner, () => {}),
        migrateUp(db.owner, () => {}),
      ]);
      // Exactly one run applies the migrations; the other finds nothing pending.
      expect(results.sort()).toEqual([0, loadMigrations().length]);
    } finally {
      await db.drop();
    }
  });
});
