/**
 * Entity registry: what the generic entity API is permitted to touch.
 *
 * A generic "any entity over HTTP" endpoint is a transitional shape, chosen
 * because the frontend reaches the backend through a compatibility shim whose
 * contract is itself generic (list/filter/get/create/update/delete). It is not
 * the end state - purpose-built endpoints replace it once the shim is retired.
 *
 * Because it is generic, the allowlist below is the load-bearing control:
 *
 *   * only tables named here are reachable at all;
 *   * column names come from information_schema at boot, so nothing a client
 *     sends can ever reach a query as an identifier - a requested column is
 *     matched against that set and rejected if absent;
 *   * generated columns are never writable;
 *   * role requirements mirror the RLS policies. That duplication is
 *     deliberate: the API fails fast with a clear 403, and PostgreSQL still
 *     refuses independently if a check is ever missed (MIGRATION_PLAN.md §5.3).
 */
import type pg from "pg";
import { withServiceRole } from "../db/client.js";
import { ROLES as SHARED_ROLES, PRODUCTION_ROLES as SHARED_PRODUCTION_ROLES } from "@allied/shared/constants";

export const ROLES = [
  // Mirrors shared ROLE_LABELS; the DB enforces the same list (0002/0011).
  ...SHARED_ROLES,
] as const;
export type Role = (typeof ROLES)[number];

export const MANAGERS: Role[] = ["admin", "sales_manager"];
export const PRODUCTION: Role[] = [...SHARED_PRODUCTION_ROLES] as Role[];
export const ADMIN_ONLY: Role[] = ["admin"];
export const AUTHENTICATED: Role[] = [...ROLES];

export interface EntityPolicy {
  /** Physical table. */
  table: string;
  /** Roles permitted each operation. `null` means the operation is not exposed. */
  read: Role[];
  create: Role[] | null;
  update: Role[] | null;
  remove: Role[] | null;
  /** Default ORDER BY when the caller does not ask for one. */
  defaultSort: string;
}

/**
 * Keyed by the entity name the frontend already uses, so the shim needs no
 * translation table of its own.
 */
export const ENTITIES: Record<string, EntityPolicy> = {
  Appointment: {
    table: "appointment",
    read: AUTHENTICATED,
    create: MANAGERS,
    // Any signed-in role may update: submitting a debrief sets debrief_status
    // on the linked appointment. RLS enforces the same rule.
    update: AUTHENTICATED,
    remove: MANAGERS,
    defaultSort: "-created_at",
  },
  Debrief: {
    table: "debrief",
    read: AUTHENTICATED,
    create: AUTHENTICATED,
    // Row-level ownership (author or manager) is enforced by RLS, not here -
    // it depends on the row, which this layer deliberately does not fetch first.
    update: AUTHENTICATED,
    remove: MANAGERS,
    defaultSort: "-created_at",
  },
  ListOption: {
    table: "list_option",
    read: AUTHENTICATED,
    create: MANAGERS,
    update: MANAGERS,
    remove: MANAGERS,
    defaultSort: "value",
  },
  MarketingSource: {
    table: "marketing_source", read: ADMIN_ONLY, create: ADMIN_ONLY,
    update: ADMIN_ONLY, remove: ADMIN_ONLY, defaultSort: "standard_source",
  },
  AppointmentImportExclusion: {
    table: "appointment_import_exclusion", read: ADMIN_ONLY, create: ADMIN_ONLY,
    update: null, remove: ADMIN_ONLY, defaultSort: "-created_at",
  },
  SyncRun: {
    table: "sync_run", read: ADMIN_ONLY, create: ADMIN_ONLY,
    update: ADMIN_ONLY, remove: null, defaultSort: "-started_at",
  },
  SyncConflict: {
    table: "sync_conflict", read: ADMIN_ONLY, create: ADMIN_ONLY,
    update: ADMIN_ONLY, remove: null, defaultSort: "-created_at",
  },
  // JobProgress mirror: read-only through the API by design. Only the sync
  // (jobs pool) writes these; exposing create/update would let a browser forge
  // "what the CRM said", which is the one thing this data must never be.
  JPAppointment: {
    table: "jp_appointment", read: AUTHENTICATED,
    create: null, update: null, remove: null,
    defaultSort: "-appointment_date",
  },
  JPJob: {
    table: "jp_job", read: AUTHENTICATED,
    create: null, update: null, remove: null,
    defaultSort: "-contract_signed_date",
  },
  // Money workflow: reads are admin-only, and writes happen exclusively
  // through the scan/approve function endpoints (jobs pool), never this API.
  JPPriceCandidate: {
    table: "jp_price_candidate", read: ADMIN_ONLY,
    create: null, update: null, remove: null,
    defaultSort: "-created_at",
  },
  // Production schedule mirror: customer addresses on a map, so reads are
  // limited to production roles (RLS: allied_is_production()). Written only
  // by the schedule sync.
  JPSchedule: {
    table: "jp_schedule", read: PRODUCTION,
    create: null, update: null, remove: null,
    defaultSort: "start_at",
  },
  JPJobLocation: {
    table: "jp_job_location", read: PRODUCTION,
    create: null, update: null, remove: null,
    defaultSort: "jp_job_id",
  },
  User: {
    table: "app_user",
    read: AUTHENTICATED,   // RLS narrows this to "own row, or everything if admin"
    // Account provisioning is an operational act (scripts/seed-user.ts), never
    // an API call - see D11. Exposing create here would rebuild the
    // registration surface Sprint 2 deliberately removed.
    create: null, update: null, remove: null,
    defaultSort: "email",
  },
};

/**
 * Base44 field names the frontend still uses, mapped to our columns.
 *
 * Confined to this layer on purpose: the database and the API speak our names,
 * and only the compatibility boundary knows the legacy ones. When the shim is
 * retired, this map is deleted and nothing else changes.
 */
export const LEGACY_FIELD_ALIASES: Record<string, string> = {
  created_date: "created_at",
  updated_date: "updated_at",
};

/** Columns never exposed by the generic API, whatever the table contains. */
const NEVER_READABLE = new Set(["password_hash", "totp_secret", "totp_last_step", "csrf_token_hash"]);

export interface ColumnMeta {
  name: string;
  udt: string;
  generated: boolean;
}

export interface EntityColumns {
  all: Map<string, ColumnMeta>;
  readable: string[];
  writable: Set<string>;
}

const columnCache = new Map<string, EntityColumns>();

/**
 * Loads column metadata once per process. Every identifier used in a query
 * originates here - from the database's own catalog - so a client-supplied
 * string can only ever be compared against this set, never concatenated into
 * SQL.
 */
export async function loadColumns(): Promise<void> {
  const tables = Object.values(ENTITIES).map((e) => e.table);
  const rows = await withServiceRole(async (c: pg.PoolClient) => {
    const { rows } = await c.query<{
      table_name: string; column_name: string; udt_name: string; is_generated: string;
    }>(
      `SELECT table_name, column_name, udt_name, is_generated
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [tables],
    );
    return rows;
  }, "entities:load-columns", { quiet: true });

  for (const [name, policy] of Object.entries(ENTITIES)) {
    const cols = rows.filter((r) => r.table_name === policy.table);
    if (cols.length === 0) throw new Error(`Entity ${name} maps to missing table ${policy.table}`);

    const all = new Map<string, ColumnMeta>();
    for (const c of cols) {
      all.set(c.column_name, {
        name: c.column_name, udt: c.udt_name, generated: c.is_generated === "ALWAYS",
      });
    }
    columnCache.set(name, {
      all,
      readable: [...all.keys()].filter((k) => !NEVER_READABLE.has(k)),
      writable: new Set([...all.values()]
        .filter((c) => !c.generated && !NEVER_READABLE.has(c.name) && c.name !== "id")
        .map((c) => c.name)),
    });
  }
}

export function columnsFor(entity: string): EntityColumns {
  const c = columnCache.get(entity);
  if (!c) throw new Error(`Columns not loaded for ${entity} - call loadColumns() at boot`);
  return c;
}

export const isKnownEntity = (name: string): boolean => Object.hasOwn(ENTITIES, name);

/** Resolves a caller-supplied field name, honouring legacy aliases. */
export function resolveField(entity: string, field: string): string | null {
  const cols = columnsFor(entity);
  const mapped = LEGACY_FIELD_ALIASES[field] ?? field;
  return cols.all.has(mapped) ? mapped : null;
}

/**
 * Adds the legacy aliases back onto an outgoing row.
 *
 * The UI still reads `created_date` in a couple of places; rather than hunt
 * those down mid-migration, the boundary that already exists for compatibility
 * absorbs it.
 */
export function withLegacyAliases<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const [legacy, actual] of Object.entries(LEGACY_FIELD_ALIASES)) {
    if (actual in out && !(legacy in out)) out[legacy] = out[actual];
  }
  return out as T;
}
