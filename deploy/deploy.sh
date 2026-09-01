#!/usr/bin/env bash
# Deploy driver for the production stack. Run on the VPS, from anywhere:
#
#   deploy/deploy.sh build            build both images (tag with TAG in .env.production)
#   deploy/deploy.sh migrate          apply pending DB migrations (the gated step, §10.5)
#   deploy/deploy.sh migrate-status   show applied/pending migrations
#   deploy/deploy.sh up               start/refresh the stack (does NOT migrate)
#   deploy/deploy.sh deploy           build + up + health check (still no migrate)
#   deploy/deploy.sh seed-user        provision the login account (interactive)
#   deploy/deploy.sh health           check the running stack
#   deploy/deploy.sh logs [service]   follow logs
#
# Migrations are deliberately their own command: a crash-looping container must
# never repeatedly attempt schema changes, and a human should watch a migration
# run. Typical release:  build -> migrate -> up -> health.
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

case "${1:-}" in
  build)
    "${COMPOSE[@]}" build backend web
    ;;
  migrate)
    "${COMPOSE[@]}" run --rm migrate
    ;;
  migrate-status)
    "${COMPOSE[@]}" run --rm migrate node dist/db/migrate.js status
    ;;
  up)
    "${COMPOSE[@]}" up -d postgres backend web
    ;;
  deploy)
    "${COMPOSE[@]}" build backend web
    "${COMPOSE[@]}" up -d postgres backend web
    health
    echo
    echo "NOTE: migrations do not run automatically. If this release includes"
    echo "schema changes, run:  deploy/deploy.sh migrate   (then re-run health)."
    ;;
  seed-user)
    "${COMPOSE[@]}" run --rm -it tools npx tsx scripts/seed-user.ts
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
