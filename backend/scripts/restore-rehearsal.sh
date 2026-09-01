#!/usr/bin/env bash
# Restores the newest backup into a scratch database and reports what came back.
#
# MIGRATION_PLAN.md §10.3 makes a rehearsed restore a CUTOVER BLOCKER. An
# untested backup is not a backup; this is the test. Run it monthly and after
# any change to backup.sh, and record the output.
#
# It never touches the production database - it restores into a throwaway and
# drops it afterwards.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${SCRIPT_DIR}/../.env" ]] && set -a && . "${SCRIPT_DIR}/../.env" && set +a

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/allied}"
ADMIN_URL="${TEST_PG_ADMIN_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"
SCRATCH="allied_restore_test_$(date -u +%s)"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

LATEST="$(find "${BACKUP_DIR}/daily" -name 'allied-*.dump.gpg' -type f 2>/dev/null | sort | tail -1)"
[[ -n "${LATEST}" ]] || { log "no backup found in ${BACKUP_DIR}/daily"; exit 1; }
log "restoring ${LATEST} into scratch database ${SCRATCH}"

cleanup() { psql "${ADMIN_URL}" -q -c "DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "${ADMIN_URL}" -q -c "CREATE DATABASE ${SCRATCH};"
RESTORE_URL="${ADMIN_URL%/*}/${SCRATCH}"

gpg --batch --quiet --decrypt --passphrase "${BACKUP_PASSPHRASE}" "${LATEST}" \
  | pg_restore --dbname="${RESTORE_URL}" --no-owner --no-privileges --exit-on-error

log "restore completed - row counts:"
psql "${RESTORE_URL}" -q -t -A -F'  ' -c "
  SELECT relname, n_live_tup
    FROM pg_stat_user_tables
   ORDER BY n_live_tup DESC, relname;" | sed 's/^/    /'

# A restore that produces an empty schema is a failure that looks like a success.
TABLES=$(psql "${RESTORE_URL}" -t -A -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
[[ "${TABLES}" -ge 8 ]] || { log "FAILED: only ${TABLES} tables restored, expected at least 8"; exit 1; }

log "PASSED: ${TABLES} tables restored from ${LATEST}"
log "Record this result - §10.3 requires a rehearsed restore before cutover."
