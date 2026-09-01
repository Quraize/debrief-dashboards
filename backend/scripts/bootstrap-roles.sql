-- Cluster-level bootstrap. Run ONCE per PostgreSQL cluster, as a superuser.
--
-- Roles are cluster-wide objects, not schema objects, so they deliberately live
-- outside the migration sequence: a down-migration must never DROP a role that
-- another database in the same cluster is still using.
--
--   allied_owner  owns every object; runs migrations. RLS does not apply to it.
--   allied_app    the backend's request path. RLS APPLIES. Never owns anything.
--   allied_jobs   background jobs that legitimately cross users. BYPASSRLS.
--
-- Passwords are set here only for local development; in production these are
-- provisioned by the deploy process and never committed.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allied_owner') THEN
    CREATE ROLE allied_owner LOGIN PASSWORD 'dev_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allied_app') THEN
    CREATE ROLE allied_app LOGIN PASSWORD 'dev_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allied_jobs') THEN
    CREATE ROLE allied_jobs LOGIN PASSWORD 'dev_jobs' BYPASSRLS;
  END IF;
END
$$;

-- allied_jobs must keep BYPASSRLS even if the role predates this script.
ALTER ROLE allied_jobs BYPASSRLS;

-- Neither runtime role may create objects or escalate.
ALTER ROLE allied_app  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE allied_jobs NOSUPERUSER NOCREATEDB NOCREATEROLE;
