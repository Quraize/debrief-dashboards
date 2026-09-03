#!/usr/bin/env bash
# Deploy driver for the production stack. Run on the VPS, from anywhere:
#
#   deploy/deploy.sh build            build both images (tag with TAG in .env.production)
#   deploy/deploy.sh migrate          apply pending DB migrations (the gated step, §10.5)
#   deploy/deploy.sh migrate-status   show applied/pending migrations
#   deploy/deploy.sh up               start/refresh the stack (refuses while migrations are pending)
#   deploy/deploy.sh deploy           build + up + health check (refuses while migrations are pending)
#   deploy/deploy.sh release          build + migrate + up + health — the everyday upgrade
#   deploy/deploy.sh seed-user <email> [role]   provision the login account (password prompted)
#   deploy/deploy.sh health           check the running stack
#   deploy/deploy.sh logs [service]   follow logs
#
# Migrations are deliberately their own step: a crash-looping container must
# never repeatedly attempt schema changes, and a human should watch a migration
# run. `release` runs it once, in front of you, between build and up. `up` and
# `deploy` refuse to start a backend whose migrations are pending — the new
# image would only crash-loop and take the site down (it did, twice) — so the
# running stack keeps serving until the migration has been applied.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/deploy/.env.production"
COMPOSE=(docker compose -f "${REPO_ROOT}/deploy/docker-compose.prod.yml" --env-file "${ENV_FILE}")

[[ -f "${ENV_FILE}" ]] || {
  echo "Missing ${ENV_FILE} — copy deploy/.env.production.example and fill it in." >&2
  exit 1
}

health() {
  echo "waiting for the backend to report healthy…"
  for _ in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T backend node -e \
      "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      echo "backend: healthy"
      "${COMPOSE[@]}" ps
      return 0
    fi
    sleep 2
  done
  echo "backend did not become healthy — check: deploy/deploy.sh logs backend" >&2
  return 1
}

migrate_status() {
  "${COMPOSE[@]}" up -d postgres >/dev/null
  "${COMPOSE[@]}" run --rm -T migrate node dist/db/migrate.js status
}

# Aborts (leaving whatever is running untouched) when the built image carries
# migrations the database has not seen. Uses the image about to be started, so
# it is exact for that image, not for whatever happens to be checked out.
refuse_if_pending() {
  local status pending
  status="$(migrate_status)"
  pending="$(printf '%s\n' "${status}" | grep -i 'PENDING' || true)"
  if [[ -n "${pending}" ]]; then
    echo >&2
    echo "REFUSING TO START: this release has migrations the database has not applied:" >&2
    printf '%s\n' "${pending}" >&2
    echo >&2
    echo "The running stack was left as it is. Apply them, then start:" >&2
    echo "    deploy/deploy.sh migrate && deploy/deploy.sh up && deploy/deploy.sh health" >&2
    echo "or do it all in one go next time:   deploy/deploy.sh release" >&2
    exit 2
  fi
}

case "${1:-}" in
  build)
    "${COMPOSE[@]}" build backend web
    ;;
  migrate)
    "${COMPOSE[@]}" run --rm migrate
    ;;
  migrate-status)
    migrate_status
    ;;
  up)
    refuse_if_pending
    "${COMPOSE[@]}" up -d postgres backend web
    ;;
  deploy)
    "${COMPOSE[@]}" build backend web
    refuse_if_pending
    "${COMPOSE[@]}" up -d postgres backend web
    health
    ;;
  release)
    "${COMPOSE[@]}" build backend web
    "${COMPOSE[@]}" run --rm migrate
    "${COMPOSE[@]}" up -d postgres backend web
    health
    ;;
  seed-user)
    [[ -n "${2:-}" ]] || { echo "usage: deploy.sh seed-user <email> [role]   (password is prompted)" >&2; exit 1; }
    "${COMPOSE[@]}" run --rm -it tools npx tsx scripts/seed-user.ts "$2" "${3:-admin}"
    ;;
  health)
    health
    ;;
  logs)
    "${COMPOSE[@]}" logs -f --tail=200 "${2:-}"
    ;;
  *)
    grep '^#   deploy/deploy.sh' "${BASH_SOURCE[0]}" | sed 's/^#   //'
    exit 1
    ;;
esac
