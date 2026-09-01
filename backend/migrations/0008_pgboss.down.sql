DO $do$
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM allied_jobs', current_database());
END
$do$;

DROP SCHEMA IF EXISTS pgboss CASCADE;
