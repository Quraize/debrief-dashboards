#!/bin/bash
# Production bootstrap — runs ONCE, on first boot with an empty data volume,
# after 10-roles.sql has created the three roles with dev passwords.
#
# Two jobs:
#   1. Replace the dev passwords with the real ones from the environment.
#   2. Hand the application database to allied_owner. Migration 0008 executes
#      `GRANT CREATE ON DATABASE` as allied_owner, which PostgreSQL only
#      permits for the database's owner — without this transfer the very
#      first `migrate` run fails.
set -Eeuo pipefail

: "${ALLIED_OWNER_PASSWORD:?ALLIED_OWNER_PASSWORD must be set}"
: "${ALLIED_APP_PASSWORD:?ALLIED_APP_PASSWORD must be set}"
: "${ALLIED_JOBS_PASSWORD:?ALLIED_JOBS_PASSWORD must be set}"

# Single quotes inside a password would end the SQL literal — double them.
sql_escape() { printf '%s' "${1//\'/\'\'}"; }

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
ALTER ROLE allied_owner PASSWORD '$(sql_escape "$ALLIED_OWNER_PASSWORD")';
ALTER ROLE allied_app   PASSWORD '$(sql_escape "$ALLIED_APP_PASSWORD")';
ALTER ROLE allied_jobs  PASSWORD '$(sql_escape "$ALLIED_JOBS_PASSWORD")';
ALTER DATABASE "$POSTGRES_DB" OWNER TO allied_owner;
SQL

echo "bootstrap: role passwords set, ${POSTGRES_DB} owned by allied_owner"
