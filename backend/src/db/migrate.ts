/**
 * SQL migration runner.
 *
 * Plain .sql files with explicit up/down pairs, rather than ORM-generated
 * migrations. The schema here is mostly things ORMs model poorly - generated
 * columns, RLS policies, column-level grants, immutable helper functions - and
 * MIGRATION_PLAN.md §8.7 requires migrations to be reversible and tested in both
 * directions, which drizzle-kit does not produce. Drizzle is still used for
 * typed queries; it just does not own the DDL.
 *
 *   npm run db:migrate            apply all pending
 *   npm run db:migrate -- status  show applied/pending
 *   npm run db:migrate -- down 1  revert the last N migrations
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Any integer works; it only has to be stable across deploys so two concurrent
// deploys serialise instead of racing each other through the same DDL.
const ADVISORY_LOCK_KEY = 4_017_2026;

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string | null;
  checksum: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const ups = readdirSync(dir).filter((f) => f.endsWith(".up.sql")).sort();
  return ups.map((file) => {
    const base = file.replace(/\.up\.sql$/, "");
    const m = /^(\d+)_(.+)$/.exec(base);
    if (!m) throw new Error(`Migration filename must be NNNN_name.up.sql: ${file}`);
    const up = readFileSync(join(dir, file), "utf8");
    let down: string | null = null;
    try {
      down = readFileSync(join(dir, `${base}.down.sql`), "utf8");
    } catch {
      down = null; // reported by `status`; blocks `down`, never blocks `up`
    }
    return { version: Number(m[1]), name: m[2]!, up, down, checksum: sha256(up) };
  });
}

async function ensureRegistry(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applied(client: pg.PoolClient) {
  const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
    `SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
  );
  return rows;
}

/**
 * An applied migration whose file has since been edited means the database and
 * the repository disagree about what the schema is. Refuse rather than guess.
 */
function assertNoDrift(files: Migration[], done: { version: number; checksum: string }[]): void {
  for (const row of done) {
    const file = files.find((f) => f.version === row.version);
    if (!file) {
      throw new Error(
        `Migration ${row.version} is applied in the database but missing from ${MIGRATIONS_DIR}. ` +
          `Restore the file or revert the migration.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new Error(
        `Migration ${row.version}_${file.name} was modified after being applied ` +
          `(db=${row.checksum} file=${file.checksum}). Never edit an applied migration - add a new one.`,
      );
    }
  }
}

export async function migrateUp(pool: pg.Pool, log = console.log): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await ensureRegistry(client);
    const files = loadMigrations();
    assertNoDrift(files, await applied(client));

    const done = new Set((await applied(client)).map((r) => r.version));
    const pending = files.filter((f) => !done.has(f.version));
    if (pending.length === 0) {
      log("migrations: up to date");
      return 0;
    }

    for (const m of pending) {
      log(`  applying ${m.version}_${m.name}`);
      try {
        await client.query("BEGIN");
        await client.query(m.up);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
          [m.version, m.name, m.checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`);
      }
    }
    log(`migrations: applied ${pending.length}`);
    return pending.length;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function migrateDown(pool: pg.Pool, steps = 1, log = console.log): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await ensureRegistry(client);
    const files = loadMigrations();
    const done = await applied(client);
    assertNoDrift(files, done);

    const target = done.slice(-steps).reverse();
    for (const row of target) {
      const m = files.find((f) => f.version === row.version)!;
      if (!m.down) throw new Error(`Migration ${m.version}_${m.name} has no .down.sql - cannot revert`);
      log(`  reverting ${m.version}_${m.name}`);
      try {
        await client.query("BEGIN");
        await client.query(m.down);
        await client.query(`DELETE FROM schema_migrations WHERE version = $1`, [row.version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Revert of ${m.version}_${m.name} failed: ${(err as Error).message}`);
      }
    }
    log(`migrations: reverted ${target.length}`);
    return target.length;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function migrateStatus(pool: pg.Pool, log = console.log): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureRegistry(client);
    const files = loadMigrations();
    const done = new Map((await applied(client)).map((r) => [r.version, r]));
    for (const m of files) {
      const row = done.get(m.version);
      const state = !row ? "PENDING" : row.checksum === m.checksum ? "applied" : "MODIFIED";
      log(`  ${String(m.version).padStart(4, "0")}  ${state.padEnd(8)} ${m.name}${m.down ? "" : "  (no down)"}`);
    }
  } finally {
    client.release();
  }
}

// ── CLI ──
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "down") await migrateDown(pool, Number(arg ?? 1));
    else if (cmd === "status") await migrateStatus(pool);
    else await migrateUp(pool);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
