# Deployment

Production runs as three containers on one VPS (MIGRATION_PLAN.md §10): Caddy
(TLS + static frontend + `/api` proxy), the Node backend (pg-boss jobs run
in-process), and PostgreSQL 16 with pgvector. The app and the API share one
origin — `https://sales.<your-domain>` — so there is no CORS and no cross-site
cookie handling anywhere.

Everything lives in `deploy/`:

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | the stack: `postgres`, `backend`, `web`, plus gated `migrate`/`tools` one-offs |
| `Dockerfile.backend` | Node 22 multi-stage build; non-root runtime; migrations shipped, never auto-run |
| `Dockerfile.web` | frontend built with Vite, baked into a Caddy image |
| `Caddyfile` | TLS, SPA fallback, `/api` → backend, cache headers |
| `init/15-bootstrap-prod.sh` | first-boot only: real role passwords + DB ownership |
| `.env.production.example` | template for `deploy/.env.production` (never committed) |
| `deploy.sh` | build / migrate / up / seed-user / health / logs |

## 1. What you need before starting

- A VPS: 2 vCPU / 4 GB RAM / 40 GB SSD is comfortable (§10.2). Ubuntu 22.04/24.04 assumed below.
- SSH access with a key.
- DNS control for the main domain: you will add one **A record** for the
  subdomain (e.g. `sales`) pointing at the VPS IP. **Create it before first
  boot** — Caddy can only obtain the certificate once the name resolves.

> **Deploying before the domain exists** is fine — the domain is only the
> `SITE_ADDRESS` variable, and nothing else in the stack knows it. But plain
> `http://<IP>` will NOT work: production session cookies are `Secure`
> (`__Host-` prefixed), and browsers refuse to store them over HTTP. Use one
> of these interim values instead:
>
> | `SITE_ADDRESS` | What you get |
> |---|---|
> | `<ip-with-dashes>.sslip.io` (e.g. `203-0-113-10.sslip.io`) | real Let's Encrypt certificate, no warnings — the closest rehearsal of the final setup. sslip.io shares LE rate limits publicly; if issuance fails, use the next option |
> | `https://<VPS-IP>` | Caddy self-signs for the IP — always works; one browser warning per device |
>
> When the real domain arrives: create the A record, change `SITE_ADDRESS`,
> run `deploy/deploy.sh up`. Caddy re-issues the certificate automatically.
> Sessions are origin-bound, so everyone logs in once more; accounts, TOTP
> enrollment, and all data are untouched.
- A **fresh JobProgress API token** (Leap → Settings → Developer). Rotate any
  token that has ever been pasted into chat.
- Offsite backup storage + a GPG passphrase stored somewhere off the VPS (P7 —
  still a cutover blocker per the migration plan).

> **If the VPS already runs another web server** on ports 80/443, the `web`
> service will not be able to bind. Either give this app its own VPS (simplest,
> matches the plan) or run only `postgres` + `backend` from this compose file
> and add the equivalent of `deploy/Caddyfile` to your existing proxy,
> forwarding `/api/*` to `127.0.0.1:<published backend port>` — in that case
> publish `backend` on 127.0.0.1 yourself in a compose override.

## 2. One-time VPS setup

```bash
# Docker (official convenience script) + compose v2
curl -fsSL https://get.docker.com | sh

# Firewall: 22, 80, 443 and nothing else (§10.2)
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable

# SSH hardening + basics
apt-get install -y fail2ban unattended-upgrades
# and in /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no
```

## 3. Get the code onto the VPS

The repo is not under version control yet (Sprint 0's P0). Until `git init` +
a private remote happens — strongly recommended before cutover — copy it:

```bash
# from your workstation, repo root:
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude '.env' --exclude '.env.*' \
  ./ deploy-user@VPS:/opt/allied/
```

Once the repo has a remote, replace this with `git clone` / `git pull` — that
also unlocks the CI pipeline and image-tag-based releases.

## 4. Configure

```bash
cd /opt/allied
cp deploy/.env.production.example deploy/.env.production
# fill in: SITE_ADDRESS, four passwords (openssl rand -hex 24 each — hex only,
# they are embedded in connection URLs), LEAP_API_TOKEN
chmod 600 deploy/.env.production
```

`SYNC_SCHEDULE_ENABLED` stays `false` for now — see §8.

## 5. First boot (order matters)

```bash
deploy/deploy.sh build          # both images
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d postgres
                                # first boot runs bootstrap: roles, passwords, DB ownership
deploy/deploy.sh migrate        # applies 0001..0008 — watch it, this is the gated step
deploy/deploy.sh seed-user      # interactive: provisions the single login account (D11)
deploy/deploy.sh up             # backend + web
deploy/deploy.sh health
```

Then in a browser: `https://sales.<domain>` → log in → enroll TOTP on the
account (Login → the app prompts; strongly recommended, it is the keys to
everything). Verify the KPI dashboard renders and `https://sales.<domain>/api/health`
returns ok.

## 6. Releases and rollback

```bash
# release (the everyday command)
git pull
deploy/deploy.sh release        # build → migrate (watch it) → up → health

# or step by step
deploy/deploy.sh build
deploy/deploy.sh migrate-status # shows PENDING rows if the release has schema changes
deploy/deploy.sh migrate
deploy/deploy.sh up && deploy/deploy.sh health

# `deploy` and `up` REFUSE to start a backend whose migrations are pending —
# the new image would only crash-loop behind Caddy (502s) — and leave the
# running stack serving until you have run `migrate`.

# rollback
# set TAG in deploy/.env.production to the previous tag you built, then:
deploy/deploy.sh up
```

Notes:
- Migrations are forward-only in spirit; every one has a tested `.down.sql`,
  but prefer roll-forward fixes in production.
- The backend drains gracefully on `up` replacement: HTTP first, then running
  jobs (bounded by `SYNC_SHUTDOWN_TIMEOUT_MS`), then pools. An interrupted
  sync/backfill resumes safely — everything is idempotent.

## 7. Backups (cutover blocker until rehearsed)

Nightly encrypted `pg_dump` shipped offsite, via **host cron** using the
existing script (`backend/scripts/backup.sh`), against the 127.0.0.1-bound
Postgres port:

```bash
apt-get install -y postgresql-client-16 gnupg rclone
# put DATABASE_URL (owner, 127.0.0.1:5432), BACKUP_PASSPHRASE, BACKUP_DIR,
# BACKUP_REMOTE into /opt/allied/backend/.env (chmod 600)
crontab -e:   15 2 * * *  /opt/allied/backend/scripts/backup.sh >> /var/log/allied-backup.log 2>&1
```

Then **rehearse a restore** with `backend/scripts/restore-rehearsal.sh` and
write down the result. An untested backup is not a backup (§10.3). Also add
disk-space alerting — Postgres + WAL fill disks quietly.

## 8. Post-deploy application rollout (JobProgress)

In the app as admin, on the JobProgress Sync page:

1. Connection test (proves the token).
2. Dry run over a recent window; sanity-check the counts.
3. **Commit backfill for one month**, inspect the dashboards' "From JobProgress"
   sections.
4. Full backfill 2026-01-01 → today (queued; progress shows per-chunk).
5. After at least one clean manual commit run: set `SYNC_SCHEDULE_ENABLED=true`
   in `deploy/.env.production`, then `deploy/deploy.sh up` to recreate the
   backend. The schedule line on the sync page flips to Active.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser shows a Caddy/TLS error on first boot | DNS record not propagated yet, or port 80 blocked — Caddy needs both to issue the certificate. `deploy.sh logs web` |
| `migrate` fails on 0008 `GRANT CREATE ON DATABASE` | database not owned by `allied_owner` — the volume predates `init/15-bootstrap-prod.sh`. Run the ALTER statements from that script manually as the superuser |
| Writes fail with 403 after login | reverse proxy not forwarding `X-Forwarded-Proto: https` (cookies are `__Host-` prefixed in production and require HTTPS). The bundled Caddyfile handles this; a custom proxy must too |
| `web` won't start: port already allocated | something else owns 80/443 on the host — see the shared-VPS note in §1 |
| Backfill queued but nothing happens | `deploy.sh logs backend` — most often a missing/invalid `LEAP_API_TOKEN` (the job fails with that message and retries) |

## 10. Staging (optional, §10.4)

A second compose project on the same box works: copy `deploy/.env.production`
to `deploy/.env.staging` with a different `SITE_ADDRESS`
(`sales-staging.<domain>`), `POSTGRES_PORT`, and project name
(`docker compose -p allied-staging …`). Keep the databases strictly separate.
