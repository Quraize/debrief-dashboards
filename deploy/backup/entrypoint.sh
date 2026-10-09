#!/bin/sh
# Schedules the nightly backup and the weekly restore rehearsal with busybox
# crond, in New York time (TZ). Cron jobs do not inherit the container's
# environment, so the settings are written once to a root-only file the jobs
# source. Job output goes to the container log (docker logs <backup>).
set -eu

if [ -z "${RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD:-}" ] || [ -z "${B2_ACCOUNT_ID:-}" ]; then
  echo "backup: B2 / restic settings are not set in deploy/.env.production; idle until they are."
  while :; do sleep 3600; done
fi

umask 077
export -p | grep -E "^export (B2_|RESTIC_|HEALTHCHECK_|BACKUP_|PG|TZ=)" > /backup/env.sh

BACKUP_CRON="${BACKUP_CRON:-30 2 * * *}"
RESTORE_TEST_CRON="${RESTORE_TEST_CRON:-0 4 * * 0}"
mkdir -p /etc/crontabs
cat > /etc/crontabs/root <<EOF
$BACKUP_CRON . /backup/env.sh && /backup/backup.sh > /proc/1/fd/1 2>&1
$RESTORE_TEST_CRON . /backup/env.sh && /backup/restore-test.sh > /proc/1/fd/1 2>&1
EOF

echo "backup: scheduled ($(date '+%Z')): nightly backup '$BACKUP_CRON', restore rehearsal '$RESTORE_TEST_CRON'"
echo "backup: repository $RESTIC_REPOSITORY · heartbeat $( [ -n "${HEALTHCHECK_BACKUP_URL:-}" ] && echo on || echo OFF )"
exec crond -f -l 8
