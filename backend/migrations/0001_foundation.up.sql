-- Extensions, deterministic helpers, and the updated_at trigger.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- pgvector is required for the RAG work in MIGRATION_PLAN.md §2.2 but is not
-- present on every developer machine, so its absence must not fail a migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector not available on this server - skipping (required in production)';
  END IF;
END
$$;

-- Formats a date as YYYY-MM-DD without depending on the DateStyle GUC.
-- A plain `d::text` cast is only STABLE, so PostgreSQL rejects it inside a
-- GENERATED column; extract() is immutable, so this is usable there.
-- Mirrors the date branch of canonicalAppointmentKey() in @allied/shared.
CREATE OR REPLACE FUNCTION allied_date_key(d date)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN d IS NULL THEN ''
    ELSE lpad(extract(year  FROM d)::text, 4, '0') || '-' ||
         lpad(extract(month FROM d)::text, 2, '0') || '-' ||
         lpad(extract(day   FROM d)::text, 2, '0')
  END
$$;

-- Mirrors norm() in @allied/shared/salesAppointment:
-- trim, lowercase, collapse internal whitespace runs to a single space.
CREATE OR REPLACE FUNCTION allied_norm(s text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION allied_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
