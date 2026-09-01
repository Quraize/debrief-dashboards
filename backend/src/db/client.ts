/**
 * Database access, split by privilege.
 *
 * Two pools, deliberately named differently so that reaching for the powerful
 * one is a visible choice in code review rather than an accident:
 *
 *   dbApp   connects as allied_app  - RLS applies. Everything in the request path.
 *   dbJobs  connects as allied_jobs - BYPASSRLS. Only background jobs that
 *           legitimately operate across all users (CRM sync, spreadsheet import).
 *
 * See MIGRATION_PLAN.md §5.3.
 */
import pg from "pg";

// node-postgres returns NUMERIC as a string to avoid float precision loss.
// That is the correct default for money, and the schema stores money as
// numeric(12,2) precisely so cents survive. Parse deliberately at the edge
// (see asMoney below) rather than globally, so nothing silently becomes a float.
const NUMERIC_OID = 1700;
const DATE_OID = 1082;
/** Anything slower than this on the privileged pool gets logged regardless. */
const SLOW_QUERY_MS = 1000;

pg.types.setTypeParser(NUMERIC_OID, (v) => v);

/**
 * A SQL `date` is a calendar date. It has no time and no timezone, so turning
 * it into a JS Date is always wrong - node-postgres does it at LOCAL midnight,
 * which silently shifts the value across the UTC boundary. On a UTC+5 machine
 * `2026-07-20` serialises to `2026-07-19T19:00:00.000Z`: the wrong day, and the
 * wrong month whenever the date falls on the first of one.
 *
 * That would corrupt every date-driven figure in the app. Worse, it fails
 * silently: inDateRange() in @allied/shared does `new Date(value + "T00:00:00")`,
 * which on an ISO string yields Invalid Date, and the record is dropped from
 * the aggregate rather than counted wrongly - a KPI that is quietly too low.
 *
 * Returning the raw 'YYYY-MM-DD' string is both correct and exactly what the
 * frontend already expects. `timestamptz` is deliberately left alone: it does
 * carry a timezone, so a JS Date is the right representation there.
 */
pg.types.setTypeParser(DATE_OID, (v) => v);

export interface SessionContext {
  /** The signed-in user's email. Compared against created_by by the write-own policy. */
  email: string;
  /** One of the six roles in app_user.role. */
  role: string;
}

function makePool(connectionString: string, application_name: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    application_name,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle-client error must never take the process down.
  pool.on("error", (err) => console.error(`[db:${application_name}] idle client error`, err));
  return pool;
}

let _app: pg.Pool | undefined;
let _jobs: pg.Pool | undefined;

export function dbApp(): pg.Pool {
  if (!_app) {
    const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL_APP (or DATABASE_URL) is not set");
    _app = makePool(url, "allied-app");
  }
  return _app;
}

export function dbJobs(): pg.Pool {
  if (!_jobs) {
    const url = process.env.DATABASE_URL_JOBS ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL_JOBS (or DATABASE_URL) is not set");
    _jobs = makePool(url, "allied-jobs");
  }
  return _jobs;
}

/**
 * Runs `fn` inside a transaction that carries the request's identity.
 *
 * The identity is set with SET LOCAL, so it is scoped to this transaction and
 * released with it. That is what makes a shared connection pool safe: one
 * request's identity can never leak into the next request that borrows the
 * same physical connection.
 *
 * set_config's third argument (`true`) is the local flag - the equivalent of
 * SET LOCAL, but parameterised, so the values cannot be injected into DDL.
 */
export async function withUser<T>(
  pool: pg.Pool,
  ctx: SessionContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_email', $1, true)", [ctx.email]);
    await client.query("SELECT set_config('app.user_role',  $1, true)", [ctx.role]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transaction on the BYPASSRLS pool, for work that legitimately spans users.
 * Every call site should be justifiable in review; `reason` is logged so the
 * audit trail in §5.5 can answer "what crossed the boundary, and why".
 */
export async function withServiceRole<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  reason: string,
  options: { quiet?: boolean } = {},
): Promise<T> {
  const client = await dbJobs().connect();
  const startedAt = Date.now();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");

    // Successes are logged selectively. Session resolution runs on every
    // authenticated request, so logging it unconditionally would bury the
    // genuinely interesting cross-user operations - a sync, an import - under
    // one line per page view. Slow calls are always logged, because a slow
    // query on this pool is worth knowing about regardless.
    const elapsed = Date.now() - startedAt;
    const verbose = process.env.LOG_SERVICE_ROLE === "true";
    if ((!options.quiet && verbose) || elapsed > SLOW_QUERY_MS) {
      console.info(`[db:service] ${reason} (${elapsed}ms)${elapsed > SLOW_QUERY_MS ? " SLOW" : ""}`);
    }
    return out;
  } catch (err) {
    // Failures are always logged: this pool bypasses RLS, so anything going
    // wrong on it is worth a line whatever the volume.
    console.error(`[db:service] ${reason} FAILED`, err);
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** NUMERIC arrives as a string; convert only where a number is genuinely wanted. */
export function asMoney(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function closePools(): Promise<void> {
  await Promise.all([_app?.end(), _jobs?.end()]);
  _app = undefined;
  _jobs = undefined;
}
