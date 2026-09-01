#!/usr/bin/env bash
# Encrypted PostgreSQL backup with offsite copy and retention.
#
# D12 made backups our responsibility. Two rules this script exists to enforce:
#   1. a backup that never leaves the VPS is not a backup - the disk that dies
#      takes both the database and the backup with it;
#   2. a backup nobody can decrypt is not a backup either - BACKUP_PASSPHRASE
#      must also be stored somewhere other than this machine.
#
# Cron:  15 2 * * *  /opt/allied/backend/scripts/backup.sh >> /var/log/allied-backup.log 2>&1
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${SCRIPT_DIR}/../.env" ]] && set -a && . "${SCRIPT_DIR}/../.env" && set +a

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required - an unencrypted offsite backup is not acceptable}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/allied}"
RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-7}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/daily"
FILE="${DEST}/allied-${STAMP}.dump.gpg"
mkdir -p "${DEST}"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
trap 'fail "line ${LINENO}"' ERR

log "starting backup -> ${FILE}"

# --format=custom so pg_restore can do selective/parallel restores.
# Piped straight into gpg: the plaintext dump never touches disk.
pg_dump --dbname="${DATABASE_URL}" --format=custom --compress=6 --no-owner --no-privileges \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "${BACKUP_PASSPHRASE}" --output "${FILE}"

SIZE=$(stat -c %s "${FILE}" 2>/dev/null || stat -f %z "${FILE}")
[[ "${SIZE}" -gt 1024 ]] || fail "backup is only ${SIZE} bytes - refusing to treat that as valid"
log "wrote ${FILE} (${SIZE} bytes)"

# Verify the archive is readable before trusting it. Catches a truncated dump
# or a wrong passphrase now, rather than during an actual incident.
gpg --batch --quiet --decrypt --passphrase "${BACKUP_PASSPHRASE}" "${FILE}" \
  | pg_restore --list > /dev/null || fail "archive failed verification"
log "verified archive is readable"

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  command -v rclone >/dev/null || fail "BACKUP_REMOTE is set but rclone is not installed"
  rclone copy "${FILE}" "${BACKUP_REMOTE}/daily/" --no-traverse
  log "copied offsite to ${BACKUP_REMOTE}/daily/"
else
  log "WARNING: BACKUP_REMOTE is unset - this backup exists only on this host"
fi

find "${DEST}" -name 'allied-*.dump.gpg' -type f -mtime "+${RETENTION_DAILY}" -delete
log "pruned local daily backups older than ${RETENTION_DAILY} days"
log "backup complete"
