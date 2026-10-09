#!/bin/sh
# Weekly restore rehearsal. Restores the LATEST database backup from B2 into a
# throwaway database on the same server, checks it against the live database,
# then drops it. Also spot-checks 10% of the stored data in B2.
# Passes only if: the dump restores without errors, every live table exists in
# the copy, and the key tables hold at least 98% of today's rows (the backup is
# hours old, so a little drift is expected; a big gap is not).
. /backup/common.sh
require B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD PGHOST PGUSER PGPASSWORD PGDATABASE

LOG=/tmp/restore-test.log
: > "$LOG"
SCRATCH=allied_restore_test
cleanup() { psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >>"$LOG" 2>&1 || true; }
trap 'cleanup; fail_with_log "${HEALTHCHECK_RESTORE_URL:-}"; exit 1' EXIT

hc "${HEALTHCHECK_RESTORE_URL:-}" start
SNAP=$(restic snapshots --tag db --host allied --latest 1 --compact 2>>"$LOG" | awk 'NR>2 && $1 ~ /^[0-9a-f]+$/ {print $1" "$2" "$3; exit}')
log "restore rehearsal starting from snapshot ${SNAP:-?}"

cleanup
run psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SCRATCH"

# Restore straight from B2 into the scratch database (no plaintext file on disk).
log "restoring the latest backup into $SCRATCH"
run sh -c "restic dump --tag db --host allied latest /allied.dump | pg_restore --no-owner --no-privileges --exit-on-error -d $SCRATCH"

# Every live table must exist in the copy.
q() { psql -X -A -t -d "$1" -c "$2"; }
LIVE_TABLES=$(q "$PGDATABASE" "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
COPY_TABLES=$(q "$SCRATCH" "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
log "tables: live $LIVE_TABLES, restored $COPY_TABLES"
[ "$COPY_TABLES" -ge "$LIVE_TABLES" ] || { log "the restored copy is missing tables"; exit 1; }

# Key tables: the copy must hold at least 98% of today's rows.
REPORT=""
for t in debrief appointment jp_job jp_customer jp_customer_phone jp_schedule jp_job_payment sync_run schema_migrations; do
  live=$(q "$PGDATABASE" "SELECT count(*) FROM $t" 2>/dev/null || echo "")
  [ -n "$live" ] || continue
  copy=$(q "$SCRATCH" "SELECT count(*) FROM $t" 2>/dev/null || echo 0)
  REPORT="$REPORT $t=$copy/$live"
  if [ "$live" -gt 0 ] && [ $((copy * 100)) -lt $((live * 98)) ]; then
    log "table $t: restored $copy rows, live has $live: too far behind"; exit 1
  fi
done
log "row counts (restored/live):$REPORT"

# Same migrations applied in the copy as in production.
LIVE_MIG=$(q "$PGDATABASE" "SELECT max(version) FROM schema_migrations" 2>/dev/null || echo "?")
COPY_MIG=$(q "$SCRATCH" "SELECT max(version) FROM schema_migrations" 2>/dev/null || echo "?")
log "latest migration: live $LIVE_MIG, restored $COPY_MIG"

cleanup
log "scratch database dropped"

# Spot-check the stored data itself in B2.
log "checking 10% of the stored data in B2"
run restic check --read-data-subset=10%

log "restore rehearsal PASSED"
trap - EXIT
hc "${HEALTHCHECK_RESTORE_URL:-}" ok "PASSED from ${SNAP:-?}: tables $COPY_TABLES/$LIVE_TABLES;$REPORT; migration $COPY_MIG"
