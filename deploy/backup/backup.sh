#!/bin/sh
# Nightly backup: database + roles + uploaded files -> restic (encrypted) on B2.
# The night only counts as done once the uploaded dump has been read back from
# B2 and parsed by pg_restore. Retention: 14 daily, 8 weekly, 12 monthly.
. /backup/common.sh
require B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD PGHOST PGUSER PGPASSWORD PGDATABASE

LOG=/tmp/backup-run.log
: > "$LOG"
trap 'fail_with_log "${HEALTHCHECK_BACKUP_URL:-}"; exit 1' EXIT

hc "${HEALTHCHECK_BACKUP_URL:-}" start
log "backup starting: database $PGDATABASE on $PGHOST -> $RESTIC_REPOSITORY"
run ensure_repo

# 1. The database, custom format, streamed straight into restic: the plaintext
#    dump never touches disk, and restic fails the snapshot if pg_dump fails.
#    Owners and grants are kept: a server rebuilt from this needs the app roles'
#    permissions and the row-level policies exactly as they are.
log "dumping the database"
run restic backup --tag db --host allied --stdin-filename allied.dump --stdin-from-command -- \
  pg_dump --format=custom --compress=6 "$PGDATABASE"

# 2. Roles (allied_app, allied_jobs, allied_owner...) so a fresh server can be rebuilt.
log "dumping roles"
run restic backup --tag roles --host allied --stdin-filename roles.sql --stdin-from-command -- \
  pg_dumpall --globals-only

# 3. Uploaded files.
if [ -d /data/uploads ]; then
  log "backing up uploaded files"
  run restic backup --tag uploads --host allied /data/uploads
fi

# 4. Read the database dump BACK from B2 and make sure it parses.
log "verifying the uploaded dump"
# pg_restore --list stops reading after the table list; the rest of the stream
# is drained (cat) so restic finishes normally and releases its lock.
TABLES=$(restic dump --tag db --host allied latest /allied.dump 2>>"$LOG" | { pg_restore --list 2>>"$LOG"; cat >/dev/null; } | grep -c ' TABLE DATA ' || true)
[ "${TABLES:-0}" -gt 20 ] || { log "verification found only ${TABLES:-0} tables in the uploaded dump"; exit 1; }
log "verified: the uploaded dump holds $TABLES tables"

# 5. Retention.
log "applying retention"
run restic forget --retry-lock 2m --host allied --group-by host,tags --keep-daily "${BACKUP_KEEP_DAILY:-14}" --keep-weekly "${BACKUP_KEEP_WEEKLY:-8}" --keep-monthly "${BACKUP_KEEP_MONTHLY:-12}" --prune

SIZE=$(restic stats --mode raw-data 2>/dev/null | awk -F': *' '/Total Size/ {print $2}')
SNAPS=$(restic snapshots --tag db --json 2>/dev/null | grep -o '"short_id"' | wc -l)
log "backup complete: $TABLES tables verified, $SNAPS database snapshots kept, repository ${SIZE:-?}"
trap - EXIT
hc "${HEALTHCHECK_BACKUP_URL:-}" ok "OK: $TABLES tables verified; $SNAPS db snapshots; repo ${SIZE:-?}"
