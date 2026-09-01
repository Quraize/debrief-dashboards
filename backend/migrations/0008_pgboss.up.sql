-- pg-boss home.
--
-- pg-boss manages its own tables (queue, schedule, job partitions) with its own
-- versioned migrations — inside this schema, never touching schema_migrations,
-- so our drift detection is unaffected. We create the schema here, owned by the
-- migration role, for two reasons:
--
--  * the down migration can then drop it cleanly (a schema owner may
--    cascade-drop contained objects it does not own);
--  * the runtime role gets exactly the privileges it needs and no more.
--
-- allied_jobs needs CREATE on the schema (pg-boss creates a partition per
-- queue at runtime) AND CREATE on the database: pg-boss runs
-- `CREATE SCHEMA IF NOT EXISTS pgboss` at startup, and PostgreSQL acl-checks
-- database-level CREATE on that statement even when the schema already exists.

CREATE SCHEMA pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO allied_jobs;

DO $do$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO allied_jobs', current_database());
END
$do$;
