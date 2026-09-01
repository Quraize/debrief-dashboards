/**
 * Query construction for the generic entity API.
 *
 * Every identifier that reaches SQL is resolved through the registry, which
 * sources its names from information_schema. Client input is only ever
 * *compared* against that set - never concatenated. Values are always bound
 * parameters. Identifiers are additionally double-quoted, so even a column
 * legitimately named `order` or `user` cannot change the parse.
 *
 * Reads and writes run through withUser() on the allied_app pool, so RLS
 * applies to every statement here.
 */
import type pg from "pg";
import { withUser, dbApp, type SessionContext } from "../db/client.js";
import { columnsFor, ENTITIES, resolveField, withLegacyAliases } from "./registry.js";

/** Hard ceiling per request. The shim pages through; nothing needs more at once. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 200;

export interface ListQuery {
  sort?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  filter?: Record<string, string> | undefined;
}

export interface ListResult<T = Record<string, unknown>> {
  data: T[];
  meta: { total: number; limit: number; offset: number; hasMore: boolean };
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Parses a Base44-style sort string: "-field" is descending, "field" ascending.
 * An unknown field is rejected rather than silently ignored - a dashboard
 * quietly sorted by the wrong column is worse than an error.
 */
export function parseSort(entity: string, sort: string | undefined): { sql: string; field: string } {
  const raw = (sort ?? ENTITIES[entity]!.defaultSort).trim();
  const desc = raw.startsWith("-");
  const field = resolveField(entity, desc ? raw.slice(1) : raw);
  if (!field) throw Object.assign(new Error(`Unknown sort field: ${raw}`), { statusCode: 400 });
  // Ties broken by id so pagination is stable: without it, two rows sharing a
  // created_at can swap between pages and be returned twice or not at all.
  return { sql: `${quote(field)} ${desc ? "DESC" : "ASC"} NULLS LAST, "id" ASC`, field };
}

interface WhereClause { sql: string; values: unknown[] }

function buildWhere(entity: string, filter: Record<string, string> | undefined, from = 1): WhereClause {
  if (!filter || Object.keys(filter).length === 0) return { sql: "", values: [] };
  const cols = columnsFor(entity);
  const parts: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(filter)) {
    const field = resolveField(entity, key);
    if (!field) throw Object.assign(new Error(`Unknown filter field: ${key}`), { statusCode: 400 });

    const meta = cols.all.get(field)!;
    // Equality only - that is the entire filter surface the frontend uses.
    // Anything richer belongs in a purpose-built endpoint, not a generic one.
    if (value === "" || value === null) {
      parts.push(`${quote(field)} IS NULL`);
      continue;
    }
    parts.push(`${quote(field)} = $${from + values.length}`);
    values.push(coerceFilterValue(value, meta.udt));
  }
  return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", values };
}

/** Query strings are text; the column may not be. */
function coerceFilterValue(value: string, udt: string): unknown {
  switch (udt) {
    case "bool": return ["true", "1", "yes"].includes(value.toLowerCase());
    case "int4": case "int8": {
      const n = Number(value);
      if (!Number.isInteger(n)) throw Object.assign(new Error(`Expected an integer, got: ${value}`), { statusCode: 400 });
      return n;
    }
    default: return value;
  }
}

export async function list(
  ctx: SessionContext, entity: string, query: ListQuery,
): Promise<ListResult> {
  const cols = columnsFor(entity);
  const table = ENTITIES[entity]!.table;
  const { sql: orderBy } = parseSort(entity, query.sort);
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const offset = Math.max(query.offset ?? 0, 0);
  const where = buildWhere(entity, query.filter);
  const select = cols.readable.map(quote).join(", ");

  return withUser(dbApp(), ctx, async (c: pg.PoolClient) => {
    // Count and page in one transaction so `total` cannot disagree with `data`
    // because of a concurrent write between the two statements.
    const { rows: countRows } = await c.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${quote(table)}${where.sql}`, where.values);
    const total = Number(countRows[0]!.total);

    const { rows } = await c.query(
      `SELECT ${select} FROM ${quote(table)}${where.sql}
        ORDER BY ${orderBy} LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, limit, offset],
    );

    return {
      data: rows.map(withLegacyAliases),
      meta: { total, limit, offset, hasMore: offset + rows.length < total },
    };
  });
}

export async function getById(
  ctx: SessionContext, entity: string, id: string,
): Promise<Record<string, unknown> | null> {
  const cols = columnsFor(entity);
  const table = ENTITIES[entity]!.table;
  const select = cols.readable.map(quote).join(", ");
  return withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query(`SELECT ${select} FROM ${quote(table)} WHERE "id" = $1`, [id]);
    return rows[0] ? withLegacyAliases(rows[0]) : null;
  });
}

/** Splits a client payload into the columns we accept, discarding the rest. */
function projectWritable(entity: string, body: Record<string, unknown>) {
  const cols = columnsFor(entity);
  const fields: string[] = [];
  const values: unknown[] = [];
  const ignored: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    const mapped = resolveField(entity, key);
    if (!mapped || !cols.writable.has(mapped)) { ignored.push(key); continue; }
    if (fields.includes(mapped)) continue; // e.g. created_date and created_at both sent
    const meta = cols.all.get(mapped)!;
    fields.push(mapped);
    // "" is a legitimate "no value" from these forms, and an illegal date.
    // Same coercion the Base44 importer applies, for the same reason.
    const isEmpty = value === "" || value === undefined;
    const typed = ["date", "timestamptz", "numeric", "int4", "int8"].includes(meta.udt);
    values.push(isEmpty && typed ? null : value === undefined ? null : value);
  }
  return { fields, values, ignored };
}

export async function create(
  ctx: SessionContext, entity: string, body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const table = ENTITIES[entity]!.table;
  const cols = columnsFor(entity);
  const { fields, values } = projectWritable(entity, body);
  if (fields.length === 0) {
    throw Object.assign(new Error("No writable fields supplied"), { statusCode: 400 });
  }
  const select = cols.readable.map(quote).join(", ");
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");

  return withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO ${quote(table)} (${fields.map(quote).join(", ")})
       VALUES (${placeholders}) RETURNING ${select}`, values);
    return withLegacyAliases(rows[0]!);
  });
}

export async function update(
  ctx: SessionContext, entity: string, id: string, body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const table = ENTITIES[entity]!.table;
  const cols = columnsFor(entity);
  const { fields, values } = projectWritable(entity, body);
  if (fields.length === 0) {
    throw Object.assign(new Error("No writable fields supplied"), { statusCode: 400 });
  }
  const assignments = fields.map((f, i) => `${quote(f)} = $${i + 1}`).join(", ");
  const select = cols.readable.map(quote).join(", ");

  return withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query(
      `UPDATE ${quote(table)} SET ${assignments}
        WHERE "id" = $${fields.length + 1} RETURNING ${select}`,
      [...values, id]);
    // Zero rows means either "no such row" or "RLS refused it". The caller is
    // told 404 for both: distinguishing them would confirm the row exists to
    // someone not allowed to see it.
    return rows[0] ? withLegacyAliases(rows[0]) : null;
  });
}

export async function remove(ctx: SessionContext, entity: string, id: string): Promise<boolean> {
  const table = ENTITIES[entity]!.table;
  return withUser(dbApp(), ctx, async (c) => {
    const { rowCount } = await c.query(`DELETE FROM ${quote(table)} WHERE "id" = $1`, [id]);
    return (rowCount ?? 0) > 0;
  });
}
