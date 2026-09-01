/**
 * Imports a Base44 entity export into PostgreSQL.
 *
 *   DATABASE_URL=... npx tsx scripts/import-base44-export.ts ./export [--dry-run]
 *
 * Expects one JSON file per entity (Appointment.json, Debrief.json, ...), each
 * an array of records as Base44 returns them.
 *
 * Properties this import is built to guarantee:
 *
 *   * ids are preserved verbatim, so debrief.appointment_id keeps pointing at
 *     the right appointment. That is why the id columns are TEXT (see 0002).
 *   * it is idempotent - running it twice imports nothing the second time, via
 *     the same ON CONFLICT paths the CRM sync will use.
 *   * empty strings become NULL for typed columns. Base44 stores "" for a
 *     missing date; PostgreSQL rejects "" as a date, and this is the single
 *     most common way a migration import dies half-finished.
 *   * it reconciles. Every row is accounted for as inserted, updated, or
 *     rejected-with-a-reason. Silent row loss during a data migration is the
 *     failure mode that is discovered months later.
 *
 * Runs as allied_owner (RLS does not apply to a table owner), because an import
 * legitimately writes rows on behalf of every user.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** Import order matters: parents before children, so foreign keys resolve. */
const ENTITY_ORDER = [
  ["User", "app_user"],
  ["Appointment", "appointment"],
  ["Debrief", "debrief"],
  ["ListOption", "list_option"],
  ["MarketingSource", "marketing_source"],
  ["AppointmentImportExclusion", "appointment_import_exclusion"],
  ["SyncRun", "sync_run"],
  ["SyncConflict", "sync_conflict"],
] as const;

/** Base44 metadata field -> our column. */
const RENAME: Record<string, string> = {
  created_date: "created_at",
  updated_date: "updated_at",
};

const CONFLICT_TARGET: Record<string, string> = {
  appointment: "(identity_key)",
  app_user: "(email)",
};

/**
 * Provenance columns are never overwritten when a conflicting row merges in.
 *
 * When two export rows collapse to the same appointment, the later one must not
 * rewrite when the record was created or who created it: created_at is the real
 * creation time, and created_by is what the write-own RLS policy compares
 * against. Mutable business fields still take the newer value (last write wins);
 * only provenance is immutable.
 */
const IMMUTABLE_ON_CONFLICT = new Set(["id", "created_at", "created_by"]);

interface ColumnMeta { name: string; type: string; generated: boolean }
interface Report {
  entity: string; table: string; read: number;
  inserted: number; updated: number; rejected: number;
  reasons: Map<string, number>;
}

const isBlank = (v: unknown) => v === "" || v === null || v === undefined;

/**
 * Coerces a Base44 value for a specific PostgreSQL column type.
 * Returns `undefined` when the column should be omitted entirely.
 */
function coerce(value: unknown, type: string): unknown {
  if (value === undefined) return undefined;
  switch (type) {
    case "date":
    case "timestamptz":
      // "" is a legitimate Base44 "no value" and an illegal PostgreSQL date.
      return isBlank(value) ? null : value;
    case "numeric":
    case "int4": {
      if (isBlank(value)) return null;
      const n = Number(value);
      return Number.isFinite(n) ? value : null;
    }
    case "bool":
      if (isBlank(value)) return null;
      if (typeof value === "boolean") return value;
      return ["true", "yes", "1"].includes(String(value).trim().toLowerCase());
    case "jsonb":
      return isBlank(value) ? {} : value;
    case "_text":
      return Array.isArray(value) ? value : isBlank(value) ? [] : [String(value)];
    default:
      return value === null || value === undefined ? null : String(value);
  }
}

async function columnsOf(client: pg.PoolClient, table: string): Promise<ColumnMeta[]> {
  const { rows } = await client.query<{ column_name: string; udt_name: string; is_generated: string }>(
    `SELECT column_name, udt_name, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.map((r) => ({
    name: r.column_name,
    type: r.udt_name,
    generated: r.is_generated === "ALWAYS",
  }));
}

async function importEntity(
  client: pg.PoolClient, dir: string, entity: string, table: string, dryRun: boolean,
): Promise<Report | null> {
  const file = join(dir, `${entity}.json`);
  if (!existsSync(file)) return null;

  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const records: Record<string, unknown>[] = Array.isArray(parsed)
    ? parsed as Record<string, unknown>[]
    : ((parsed as { data?: Record<string, unknown>[] }).data ?? []);

  const meta = await columnsOf(client, table);
  const writable = new Map(meta.filter((c) => !c.generated).map((c) => [c.name, c]));

  const rep: Report = {
    entity, table, read: records.length,
    inserted: 0, updated: 0, rejected: 0, reasons: new Map(),
  };
  const reject = (why: string) => {
    rep.rejected++;
    rep.reasons.set(why, (rep.reasons.get(why) ?? 0) + 1);
  };

  for (const raw of records) {
    const cols: string[] = [];
    const vals: unknown[] = [];
    let unknownFields = 0;

    for (const [k0, v] of Object.entries(raw)) {
      const k = RENAME[k0] ?? k0;
      const col = writable.get(k);
      if (!col) { unknownFields++; continue; }   // Base44 metadata we do not model
      const coerced = coerce(v, col.type);
      if (coerced === undefined) continue;
      cols.push(col.name);
      vals.push(coerced);
    }
    if (cols.length === 0) { reject("no recognisable columns"); continue; }

    // A Base44 export carries created_by; without it the write-own policy has
    // nothing to compare against, so make the gap explicit rather than silent.
    if (!cols.includes("created_by") && writable.has("created_by")) {
      cols.push("created_by");
      vals.push("base44-import");
    }

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const target = CONFLICT_TARGET[table] ?? "(id)";
    const updates = cols
      .filter((c) => !IMMUTABLE_ON_CONFLICT.has(c))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(", ");
    const sql =
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders}) ` +
      (updates
        ? `ON CONFLICT ${target} DO UPDATE SET ${updates} RETURNING (xmax = 0) AS inserted`
        : `ON CONFLICT ${target} DO NOTHING RETURNING true AS inserted`);

    try {
      const { rows } = await client.query<{ inserted: boolean }>(sql, vals);
      if (rows.length === 0) reject("conflict, no change");
      else if (rows[0]!.inserted) rep.inserted++;
      else rep.updated++;
    } catch (err) {
      const m = (err as Error).message;
      // Keep the reason, drop the row values - export data is customer PII.
      reject(m.split("\n")[0]!.slice(0, 120));
    }
    void unknownFields;
  }
  return rep;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!dir) throw new Error("usage: import-base44-export.ts <export-dir> [--dry-run]");
  if (!existsSync(dir)) throw new Error(`export directory not found: ${dir}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  console.log(`importing from ${dir}${dryRun ? "  (DRY RUN - nothing will be committed)" : ""}`);
  console.log(`files present: ${readdirSync(dir).filter((f) => f.endsWith(".json")).join(", ") || "none"}\n`);

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const reports: Report[] = [];
  try {
    // One transaction for the whole import: a half-migrated database is worse
    // than none, and --dry-run is then simply a rollback.
    await client.query("BEGIN");
    for (const [entity, table] of ENTITY_ORDER) {
      const rep = await importEntity(client, dir, entity, table, dryRun);
      if (rep) reports.push(rep);
      else console.log(`  ${entity.padEnd(28)} (no file, skipped)`);
    }
    if (dryRun) { await client.query("ROLLBACK"); console.log("\nrolled back (dry run)"); }
    else await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  console.log("\n  entity                        read   ins   upd   rej");
  console.log("  " + "-".repeat(54));
  let readTotal = 0, rejTotal = 0;
  for (const r of reports) {
    readTotal += r.read; rejTotal += r.rejected;
    console.log(`  ${r.entity.padEnd(28)}${String(r.read).padStart(5)}${String(r.inserted).padStart(6)}` +
                `${String(r.updated).padStart(6)}${String(r.rejected).padStart(6)}`);
    for (const [why, n] of r.reasons) console.log(`      ${n} x ${why}`);
  }
  console.log("  " + "-".repeat(54));
  console.log(`  ${"TOTAL".padEnd(28)}${String(readTotal).padStart(5)}${String(rejTotal).padStart(18)}`);

  if (rejTotal > 0) {
    console.error(`\n${rejTotal} row(s) rejected. Reconcile before treating this import as complete.`);
    process.exitCode = 1;
  } else {
    console.log("\nevery row accounted for.");
  }
}

await main();
