#!/bin/sh
# Shared by backup.sh and restore-test.sh. Sourced, never run.
#
# Settings (deploy/.env.production, passed by docker-compose.prod.yml):
#   B2_ACCOUNT_ID / B2_ACCOUNT_KEY   Backblaze application key, limited to the bucket
#   RESTIC_REPOSITORY                b2:<bucket>:allied
#   RESTIC_PASSWORD                  the encryption key. ALSO keep it in the password
#                                    manager: without it the backups cannot be read.
#   HEALTHCHECK_BACKUP_URL           Healthchecks.io ping URL for the nightly backup
#   HEALTHCHECK_RESTORE_URL          Healthchecks.io ping URL for the weekly rehearsal
#   PGHOST / PGUSER / PGPASSWORD / PGDATABASE   the database, as the superuser
set -eu

# Every line goes to the container log and to $LOG (the tail is what a failure
# ping carries to Healthchecks.io).
log() {
  line="$(date '+%Y-%m-%d %H:%M:%S %Z')  $*"
  echo "$line"
  if [ -n "${LOG:-}" ]; then echo "$line" >> "$LOG"; fi
  return 0
}

# A step's own output goes to $LOG only; on failure its tail is printed too.
run() { "$@" >>"$LOG" 2>&1; }

fail_with_log() {
  url="$1"
  log "FAILED"
  echo "----- last output -----"
  tail -n 40 "$LOG" 2>/dev/null || true
  hc "$url" fail "$(tail -c 9000 "$LOG" 2>/dev/null)"
}

require() {
  for v in "$@"; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || { log "FAILED: $v is not set"; exit 2; }
  done
}

# Healthchecks.io: /start when a run begins, the bare URL on success,
# /fail (with the log tail) on failure. A missed ping emails the owner.
hc() {
  url="$1"; what="$2"; body="${3:-}"
  [ -n "$url" ] || return 0
  case "$what" in
    start) curl -fsS -m 10 --retry 3 -o /dev/null "$url/start" || true ;;
    ok)    curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$body" "$url" || true ;;
    fail)  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$body" "$url/fail" || true ;;
  esac
}

# The repository is created on the first run only.
ensure_repo() {
  if ! restic cat config >/dev/null 2>&1; then
    log "no restic repository at $RESTIC_REPOSITORY yet: initialising"
    restic init
  fi
}
