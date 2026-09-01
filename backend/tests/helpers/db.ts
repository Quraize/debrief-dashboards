/**
 * Test-database lifecycle.
 *
 * Every test file gets its own throwaway database, created from the real
 * migrations rather than a hand-maintained fixture schema. If the migrations
 * are wrong, the tests cannot pass - which is the point.
 *
 * Requires a reachable PostgreSQL and the roles from scripts/bootstrap-roles.sql.
 * Locally the suite skips (loudly) when no server is available; in CI it fails,
 * because a silently-skipped security test is worse than no test at all.
 */
import pg from "pg";
import { migrateUp } from "../../src/db/migrate.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const HOST_PART = ADMIN_URL.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");

export interface TestDb {
  name: string;
  owner: pg.Pool;
  app: pg.Pool;
  jobs: pg.Pool;
  drop: () => Promise<void>;
}

export async function pgReachable(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Loud skip locally, hard failure in CI. */
export function requirePg(reachable: boolean): void {
  if (reachable) return;
  const msg = `PostgreSQL not reachable at ${HOST_PART} - database tests cannot run.`;
  if (process.env.CI) throw new Error(msg);
  console.warn(`\n  SKIPPED: ${msg}\n  Start Postgres and run scripts/bootstrap-roles.sql to enable them.\n`);
}

export async function createTestDb(label: string): Promise<TestDb> {
  const name = `allied_test_${label}_${Date.now().toString(36)}`;
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name} OWNER allied_owner`);
  await admin.end();

  const url = (user: string, pw: string) => `postgres://${user}:${pw}@${HOST_PART}/${name}`;
  const owner = new pg.Pool({ connectionString: url("allied_owner", "dev_owner"), max: 2 });
  await migrateUp(owner, () => {}); // silent: migration output is noise in test logs

  const app = new pg.Pool({ connectionString: url("allied_app", "dev_app"), max: 3 });
  const jobs = new pg.Pool({ connectionString: url("allied_jobs", "dev_jobs"), max: 2 });

  return {
    name,
    owner,
    app,
    jobs,
    async drop() {
      await Promise.all([owner.end(), app.end(), jobs.end()]);
      const a = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Runs a statement as a given identity, exactly as withUser() does at runtime. */
export async function asUser<T>(
  pool: pg.Pool,
  email: string,
  role: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_email', $1, true)", [email]);
    await c.query("SELECT set_config('app.user_role', $1, true)", [role]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Asserts a query is refused, and returns the error for further inspection. */
export async function expectDenied(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("Expected the operation to be denied, but it succeeded");
}
