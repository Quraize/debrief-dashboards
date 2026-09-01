# Allied Sales Sync — Backend Migration Plan

**Status:** Approved, not started (Phase 0 hardening applied)
**Last updated:** 2026-08-30
**Owner:** TBD

Moving off Base44 onto a self-hosted Node backend, without changing the UI or the way the team works.

---

## Table of contents

1. [Why we're doing this](#1-why-were-doing-this)
2. [Decisions log](#2-decisions-log)
3. [Current-state assessment](#3-current-state-assessment)
4. [Target architecture](#4-target-architecture)
5. [Security design](#5-security-design)
6. [Repository structure](#6-repository-structure)
7. [Data model](#7-data-model)
8. [Testing strategy (TDD)](#8-testing-strategy-tdd)
9. [Sprint plan](#9-sprint-plan)
10. [Deployment and operations](#10-deployment-and-operations)
11. [Risks](#11-risks)
12. [Open questions](#12-open-questions)
13. [Sprint 0 prerequisites](#13-sprint-0-prerequisites)
14. [Appendix: measured inventory](#appendix-measured-inventory)

---

## 1. Why we're doing this

The app is an internal sales debrief and KPI system for Allied Roofing. Reps file a post-appointment debrief, it's matched to a CRM appointment imported from JobProgress/Leap, and the results roll up into dashboards that drive commission-relevant reporting.

It currently runs entirely on Base44. We're leaving because:

- **No SLA at any tier.** A multi-hour platform-wide outage occurred on 2026-02-03 with no public post-mortem.
- **Platform-level security exposure.** In July 2025, Wiz Research disclosed a critical authentication bypass: anyone could register a verified account on a *private* Base44 app using only its `app_id`, a value public in URLs and manifests. Patched in 24 hours with no evidence of exploitation, but the class of bug matters — internal apps holding PII, which is exactly this app.
- **Support degradation** post-Wix-acquisition, reported as hours → days/weeks.
- **Bounded but real lock-in.** `base44 eject` downloads source but creates *another Base44 project*; it is not an exit.

The lock-in turned out to be shallower than expected, which is what makes this migration tractable — see [§4](#4-target-architecture).

### 1.1 Project 1 — Sales + Marketing + Calls Measurement System

**Purpose:** validate and improve the reporting Allied already uses. **Status:** start immediately.

This is the actual goal. The migration is not an end in itself — it is the foundation Project 1 needs. You cannot credibly *validate* reporting that runs on 500-row client-side aggregation with four divergent copies of the classification rules; you would be validating numbers the system cannot compute reliably.

So the order is: **fix the foundation, then extend the measurement.** Sprints 0–6 deliver the foundation. The gaps in [§1.2](#12-what-project-1-already-has-and-what-it-doesnt) become the Project 1 backlog that follows.

### 1.2 What Project 1 already has, and what it doesn't

All three areas exist today, but they are not equally mature. Measured against the code, not assumed:

| Area | Coverage | Verdict |
|---|---|---|
| **Sales** | Deep | Validate and correct — do not rebuild |
| **Marketing** | Conversion only | Extend — no spend data means no efficiency measurement |
| **Calls** | Outcomes only | **Largest gap** — it does not measure calls |

#### Sales — genuinely strong

`SalesRepDashboard`, `KpiDashboard`, `ManagerReport` and `ResultsReview` are backed by a substantial metric set in `kpi.js`: Demo Rate, No-Demo, No-See, Reset Rate and Recovery, Two-Leg %, Sales %, First Call Close %, Financing Offered %, credit declines, cancellations, average job size — plus split-rep crediting and signed-month sale attribution, which are genuinely sophisticated.

The problem here is not missing capability, it is **trustworthiness**: the 500-row cap, the divergent classifiers, and the absence of any test coverage. Project 1's sales workstream is therefore mostly the migration itself, plus the golden-master reconciliation in Sprint 3. That reconciliation *is* the validation Project 1 asks for.

#### Marketing — measures conversion, not efficiency

`MarketingDashboard` plus `marketingSources.js` is a real asset: 14 categories, ~90 canonical sources, alias mapping that never renames raw values, and per-source funnel stats (unique leads → eligible appointments → demos → sales → revenue).

**But there is no spend anywhere in the system.** No cost, budget, impression or click field exists on any entity. That means today you can answer *"which sources convert best?"* but not *"which sources are worth the money?"* — no cost per lead, no cost per sale, no ROAS, no channel-level payback.

Project 1 backlog:
- A `marketing_spend` table (source/campaign × period × amount), manually entered at first
- Cost per lead, cost per appointment, cost per sale, ROAS by source and category
- Later: pull spend automatically from Google Ads / Meta rather than keying it in

#### Calls — the dashboard is misnamed

`AppointmentSetterDashboard` is labelled "Call Center / Appointment Setters", but `setterStats()` derives everything from debriefs: appointments set, demos, sales, revenue, two-leg, close rate, a sales-efficiency ratio, missing debriefs.

Every one of those is an **outcome of an appointment that was already booked.** There is no call activity in the system at all — no dials, no connects, no talk time, no contact rate, no call-to-appointment conversion. If a setter makes 300 dials to book 4 appointments, the app cannot see the 300.

That is the real gap in Project 1, and it is the one that needs a new data source rather than new maths.

Project 1 backlog:
- Decide the source of truth for call activity — the dialer or phone system (which one is in use is [open question 7](#12-open-questions))
- A `call_activity` table: setter × period × dials, connects, talk time, outcomes
- Contact rate, dials-per-appointment, call-to-appointment conversion, activity vs. outcome per setter
- Only then is "Call Center" an accurate name for that dashboard

---

## 2. Decisions log

Every decision made so far, with the reasoning, so nobody re-litigates them mid-sprint.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Migrate off Base44** rather than harden in place | No SLA, outage history, platform vuln class, vendor risk outside our control |
| D2 | **Access model: read-all, write-own** | ⚠️ *Largely moot under D11 (single account) — retained as the target model for when multi-user onboarding lands. Columns and middleware are built now so it drops in without a rewrite.* |
| D3 | **Backend language: Node.js + TypeScript** | See [§2.1](#21-why-node-not-django) — this one is evidence-driven, not preference |
| D4 | ~~Supabase for Auth + Postgres only~~ | **Superseded by D11 + D12.** Rationale was that auth is risky to self-build — which held for a six-role multi-user system, but not for a single shared account |
| D5 | **The frontend never talks to the database directly** | All data access goes through our Node API. The browser holds a session cookie and nothing else |
| D6 | **Repo split: `frontend/` + `shared/` + `backend/`** | `shared/` is the point — see [§2.1](#21-why-node-not-django) |
| D7 | **Keep the UI unchanged** | The whole frontend touches Base44 through ~20 functions; a compatibility layer at that seam means zero page rewrites |
| D8 | **Claude API for spreadsheet extraction** | Replaces Base44's `ExtractDataFromUploadedFile`. `claude-opus-5` with structured outputs |
| D9 | **Postgres enforces record identity** | A unique constraint kills the duplicate-appointment bug that is unfixable on Base44 |
| D10 | **TDD, with golden-master tests for the KPI engine** | See [§8](#8-testing-strategy-tdd). Non-negotiable: this is how 1,750 lines of subtle business logic migrate safely |
| D11 | **One shared login account for now**; in-platform onboarding later | Internal tool, small team, start immediately. Removes the entire auth build-out from the critical path. Attribution is unaffected — see [§5.1](#51-authentication-single-account) |
| D12 | **Dedicated PostgreSQL, self-hosted on the VPS.** No Supabase | Full ownership of the data layer, no third-party account. Makes backups our responsibility — a cutover blocker, see [§10.3](#103-database-dedicated-postgresql) |
| D13 | **Project 1 is the goal; the migration is its foundation** | See [§1.1](#11-project-1--sales--marketing--calls-measurement-system) |
| D14 | **The JobProgress sync is rewritten, not ported** | The vendor spec contradicts several assumptions in the current client, including a rate limit it exceeds 5x. See `docs/jobprogress-api.md` |
| D15 | **Plain SQL migrations with an in-repo runner**, not ORM-generated DDL | The schema is mostly things ORMs model poorly - generated columns, RLS policies, column-level grants - and §8.7 requires reversible migrations, which drizzle-kit does not produce. Drizzle keeps the typed query layer; it does not own the DDL |
| D16 | **`id` columns are TEXT, not UUID** | Base44 ids must survive the import verbatim so `debrief.appointment_id` keeps resolving, and their format is unverified until the export arrives. A UUID column would reject anything that is not one. New rows default to a UUID rendered as text |
| D17 | **Record identity is a generated column, not application logic** | `appointment.identity_key` is computed by PostgreSQL using the same rule as `canonicalAppointmentKey()`, and a test asserts the two agree byte-for-byte. The unique constraint then makes import and sync idempotent by construction |
| D18 | **Server-side sessions in an httpOnly cookie, not a JWT in localStorage** | A JWT readable by JavaScript is exfiltrable by any XSS and cannot be revoked before it expires. A server-side session can be killed instantly, which matters far more when one shared credential opens everything (D11) |
| D19 | **The auth layer uses the `allied_jobs` pool exclusively** | Authentication happens before an identity exists, so it cannot run inside a user's RLS context. The consequence is a real security gain: `allied_app` has no privilege on `session` or `auth_event` at all, so SQL injection in any request handler cannot read or forge a session |
| D20 | **The frontend auth cutover moves to Sprint 3** | Rewriting `AuthContext.jsx` now would leave the app authenticating against our backend while its data calls still go to Base44 — working with neither. It lands with the data shim, in one coherent change |
| D21 | **The shim pages to completion; `limit` is advisory** | Every call site passes 500, inherited from a Base44 platform cap, and that cap is why KPIs under-report (§3.2). Since dashboards aggregate in the browser, a truncated fetch produces a *wrong number* rather than an error. This is §7.3 step one: correctness restored with zero page changes |
| D22 | **The `base44` export name survives one more commit** | Renaming 84 references in the same change that swapped the backend would bury a real behavioural change among hundreds of identifier edits. `client.js` exports `api` and aliases `base44`; the alias is removed in a follow-up that changes nothing else |
| D23 | **The merged non-sales list is the UNION of all four copies** | Every keyword any implementation excluded is kept, so nothing that used to be filtered out silently starts counting. `warranty callback` and `measurement` were dropped only as redundant — substring matching means `warranty` and `measure` already cover them. One keyword (`callback`) is contested and flagged in the source |

### 2.1 Why Node, not Django

Not a style preference. The sales-appointment classification rules currently exist in **four copies** — two frontend, two backend — and they have already drifted. Only 6 of 19 keywords appear in all four:

| Copy | Keywords | Governs |
|---|---|---|
| `base44/functions/importAppointments` | 16 | writes `is_sales_appointment` at import |
| `base44/functions/syncLeapJobProgress` | 13 | what the CRM sync excludes |
| `src/lib/appointmentClassification.js` | 17 | KPI bucketing, two-leg eligibility |
| `src/lib/salesAppointment.js` | 8 | currently uncalled (a latent trap) |

`"ROOF INSPECTION EST"` is non-sales to the import, non-sales to the sync, and a valid sales appointment to the fourth copy. The reason this happened is written in the code itself:

> `// The backend cannot import the frontend helper, so an equivalent is maintained here.`

That constraint is the whole argument. **Node removes it. Django would make it permanent and add a language boundary on top** — the same revenue rules maintained in JavaScript *and* Python forever, with direct evidence in front of us that copies drift.

Two reinforcing reasons:

- **~1,450 lines of backend logic are already TypeScript.** Base44 functions are Deno (`fetch`, `Response.json()`, npm specifiers). Porting to Node is mechanical; to Django it's a full rewrite of the JobProgress sync client, the import matcher and the Sheets upsert.
- **KPI aggregation moves server-side eventually** (see [§3](#3-current-state-assessment)). That's `kpi.js` — 729 lines encoding signed-month sale attribution, split-rep crediting and two-leg eligibility. In Node that's an `import`. In Django it's re-deriving our most subtle business logic in a second language and keeping two implementations in sync.

Django would have been right if the team were Python-first, or if Django Admin were worth having — but `AdminSettings` and `AppointmentRecords` already exist, so the admin is redundant.

### 2.2 Future workloads this must support

Automations, AI agents and probably RAG. Node/TypeScript serves all three well, and owning the Postgres instance (D12) helps rather than hinders:

- **RAG** → `pgvector` in the *same* Postgres. No new datastore, no sync problem, embeddings live next to the business data they describe.
- **Agents / automations** → the Anthropic TypeScript SDK is first-class, and `shared/` business logic is directly importable as agent tools.
- **Background work** → see [§4.3](#43-background-jobs). Agent runs and syncs must never happen in the request path.

---

## 3. Current-state assessment

What we found auditing the existing system. These are the problems the migration must actually solve.

### 3.1 Fixed already (Phase 0, applied 2026-08-29)

These are local edits in the working copy — **nothing is live until deployed.**

| Change | Detail |
|---|---|
| **Build repaired** | `tailwind.config.js` used CommonJS (`module.exports`, `require()`) inside a `"type": "module"` package. The project did not build at all. Converted to ESM; `npm run build` now succeeds |
| **`Debrief` RLS** | Was `create/read/update: null` — which Base44 documents as *accessible to all users*. Now read by any signed-in role, edited only by author + managers |
| **`Appointment` / `ListOption` RLS** | Made explicit rather than relying on undefined `null` behaviour. Roles enumerated deliberately: `true` means *including anonymous*, which on customer PII is the worst option |
| **`pushDebriefToSheet` authorization** | Had no role check — any signed-in user could push an arbitrary debrief into the company master sheet using the shared OAuth token. Now author-or-manager. Owner-based **on purpose**, so the on-create workflow (which fires as the submitting rep) keeps working |
| **`User.role` field lock** | Now admin-write-only, closing a possible privilege-escalation path. ⚠️ **Test registration immediately after deploy** — we could not verify whether Base44's own registration writes `role` as user or service role |

### 3.2 Correctness bugs the migration fixes

**Silent duplicate creation.** Both `importAppointments` and the commit path of `syncLeapJobProgress` match new records against `list("-created_date", 500)`. Past 500 appointments, older rows fall out of the match window and get recreated as duplicates on every run. The half-hourly cron would compound this unattended.

The app already knows the correct identity key — `canonicalAppointmentKey()` in `salesAppointment.js` defines it as lead ID + date + time — it simply has no way to *enforce* it. Postgres does. See [§7.2](#72-constraints-that-fix-bugs).

**KPIs that under-report.** Every dashboard pulls 500 records to the browser and aggregates client-side. The numbers are already wrong today and degrade as data grows. Base44 caps at 5,000 per request regardless.

**Dead sync telemetry.** `SyncRun` and `SyncConflict` are read by the UI and written by nothing. "Last Successful Commit" always reads *Never*; the exceptions panel is always empty; `counts.proposed_updates` is never incremented so the "updates" figure is permanently zero. The sync function builds a `conflicts` array in memory and discards it.

**Four divergent classification rule sets.** See [§2.1](#21-why-node-not-django).

### 3.3 Housekeeping

- `src/pages/OAuthConsent.jsx` — 239-line orphan, no route, references a `base44/mcp/` directory that doesn't exist. **Delete, don't port.**
- `src/components/StatTable.jsx` — unreferenced.
- 14 lint errors, all unused imports. `npm run lint:fix` clears them.
- `base44/config.jsonc` still names the project `"untitled"`.

### 3.4 Secrets audit — clean

No hardcoded credentials anywhere. `LEAP_API_TOKEN` and `GOOGLE_SHEETS_SPREADSHEET_ID` are read server-side via `secrets.get()`; the Google Sheets connection is an OAuth connector token, not a static key. No `.env` files in the working copy. The only public value is `VITE_BASE44_APP_ID`, public by design.

Carry forward:
- `inspectLeapSchema` and `testLeapConnection` are gated to admin **or sales_manager** — a manager can probe the CRM API. Tighten to admin-only.
- **Anything prefixed `VITE_` ships to the browser.** `LEAP_API_TOKEN` must live only in `backend/.env`. Guard this in code review.
- Google Sheets access moves to a **service account key** ([§4.5](#45-google-sheets-uses-a-service-account-not-oauth)) — a long-lived credential that must be treated like a password.

---

## 4. Target architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser — React + Vite (frontend/)                      │
│  Holds: a session cookie. Nothing else.                  │
└────────────────────────┬────────────────────────────────┘
                         │  session cookie (httpOnly)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Node 22 + Fastify + TypeScript  (backend/)              │
│    • validates the server-side session                   │
│    • enforces authorization (role + ownership)           │
│    • owns ALL business APIs                              │
│    • imports shared/ for business rules                  │
└───┬─────────────┬──────────────┬───────────────┬────────┘
    │             │              │               │
    ▼             ▼              ▼               ▼
 Postgres    JobProgress    Google Sheets    Claude API
 (ours, on    /Leap API       (OAuth)        (extraction,
 the VPS)     LEAP_API_                       agents, RAG)
 + pgvector   TOKEN
```

**Everything in this diagram except the three external APIs runs on our VPS.** No managed database, no third-party auth service, no direct browser→DB access. Every business API is ours.

### 4.1 The compatibility seam

The whole frontend reaches Base44 through ~20 functions. `src/api/base44Client.js` is rewritten to call our Node API while exporting an object of the same shape, so pages, components and `shared/` are untouched.

The shim must preserve exact call signatures:

```ts
entities.<E>.list(sort?, limit?)          // sort: "-created_date" = descending
entities.<E>.filter(eqObject, sort?, limit?)  // only simple equality is ever used
entities.<E>.get(id)
entities.<E>.create(data)
entities.<E>.update(id, data)
entities.<E>.delete(id)
functions.invoke(name, body)              // MUST return { data }
auth.me() / login / register / logout / reset / OTP  (12 methods)
integrations.Core.UploadFile({ file })    // returns { file_url }
```

> **Contract tests are mandatory here** — these shapes are load-bearing for 84 call sites. See [§8.4](#84-contract-tests).

Once the migration is stable, the shim can be gradually replaced with a cleaner API client. That is deliberately *not* in scope: it would turn a backend migration into a frontend rewrite.

### 4.2 Component mapping

| Base44 | Replacement |
|---|---|
| `entities/*.jsonc` | Postgres tables + Drizzle schema |
| `rls: {}` | Postgres RLS policies (defense-in-depth) + backend authorization (primary) |
| `base44.auth.*` | Our own session auth ([§5.1](#51-authentication-single-account)) |
| `functions/` (5) | Fastify routes + job handlers |
| Incremental sync workflow (cron) | Scheduled job ([§4.3](#43-background-jobs)) |
| Push-debrief workflow (on-create) | Backend emits the job after a successful debrief write |
| `connectors.getConnection("googlesheets")` | **Google service account** — see [§4.5](#45-google-sheets-uses-a-service-account-not-oauth) |
| `Core.UploadFile` | Backend upload endpoint → local volume or S3-compatible object storage |
| `Core.ExtractDataFromUploadedFile` | Claude API, `claude-opus-5`, structured outputs |
| `asServiceRole` | Explicit service DB role, used deliberately and audited |

### 4.3 Background jobs

Sync, import, sheet-push and any future agent run are **not** request-path work. Use **pg-boss** — a Postgres-backed queue, so no Redis and no new infrastructure, with scheduling built in.

Jobs to define:
- `leap.sync.incremental` — cron, currently every 30 min with a 1-day overlap (inactive by default; keep it that way until verified)
- `sheets.pushDebrief` — triggered after debrief create
- `import.extractAndLoad` — triggered by upload
- Future: `agent.*` runs

> **Daylight saving:** the existing workflow is configured for `America/New_York`. Schedule in UTC and handle the offset explicitly, or the sync window silently shifts by an hour twice a year.

### 4.4 Stack summary

| Layer | Choice |
|---|---|
| Runtime | Node 22 LTS, TypeScript strict |
| HTTP | Fastify |
| DB access | Drizzle ORM + `drizzle-kit` migrations |
| Database | **Dedicated PostgreSQL 16+ on the VPS**, `pgvector` for future RAG |
| Auth | Own session auth: argon2id + server-side sessions + TOTP |
| Queue/cron | pg-boss |
| Validation | Zod (shared request/response schemas) |
| Tests | Vitest, Testcontainers, Playwright |
| LLM | Anthropic TypeScript SDK |

---

### 4.5 Google Sheets uses a service account, not OAuth

**This has nothing to do with user login.** It is how the backend authenticates to the Google Sheets API in order to write debriefs into the master spreadsheet (`pushDebriefToSheet`). Under D11 there is no Google sign-in for users at all.

Today this rides on Base44's `googlesheets` OAuth connector — a *user-delegated* flow, because that is the only model Base44 offers. Once we own the backend, that model is the wrong fit: nobody is sitting at a browser when a debrief syncs at 2am.

**Use a Google service account instead:**

1. Create a service account in a Google Cloud project; enable the Sheets API.
2. **Share the target spreadsheet with the service account's email address**, as Editor. One-time action.
3. The backend authenticates with the service account key. No consent screen, no user interaction.

Why this is better than porting the OAuth flow:

| | OAuth (user-delegated) | Service account |
|---|---|---|
| Consent screen | Required | None |
| **Google verification review** | Required for external apps on the sensitive Sheets scope — **weeks** | **Not required** |
| Credential to store | Refresh token | Service account key |
| Breaks when the authorizing employee leaves | **Yes** | No |
| Fits a headless 2am job | Poorly | Exactly |

The "employee leaves" row matters: a user-delegated token is tied to a person, so offboarding silently breaks the sheet sync. A service account is tied to the system.

> **Correction to an earlier version of this plan:** Google OAuth consent verification was listed as the longest lead time in the project and a Sprint 0 blocker. With a service account it is **not required at all**, and this stops being on the critical path. If OAuth is ever used instead, note that an *Internal* consent screen (restricted to the company Workspace) also skips verification — only External apps need review.

---

## 5. Security design

The brief is "safe and sound". Concretely, that means **two independent layers** — if backend authorization has a gap, the database still refuses.

### 5.1 Authentication (single account)

Under D11 there is one shared login. That removes GoTrue, JWKS, OTP and password-reset flows from scope — but it changes the threat model rather than removing it, and the controls below are **not optional** because one credential now opens everything.

Build it small and correct:

- **A real `app_user` row, not a hardcoded env password.** One row, seeded. Password hashed with **argon2id** (bcrypt acceptable). Adding users later is then an INSERT plus an onboarding UI, not a re-architecture.
- **Server-side sessions** over an `httpOnly`, `Secure`, `SameSite=Lax` cookie. No JWT in `localStorage` — with a single high-privilege credential, an XSS-readable token is the worst option available.
- **CSRF protection** on all state-changing routes (cookie auth needs it; bearer tokens did not).
- **Rate limiting and lockout** on the login route. One account means one guessing target.
- **TOTP 2FA on that account.** Strongly recommended: it is the keys to the entire system, and it is a small amount of work.
- Keep `requireRole()` middleware in place even though the single account is `admin`. It costs nothing now and is the seam multi-user drops into.

**Nobody can sign up.** This is enforced in three places, not one: there is no registration route on the backend (a test asserts it 404s), the Google sign-in buttons are deleted from the UI, and the only credential that exists is the seeded row. Someone hitting the API directly still has nothing to call.

> **What a single account costs you, stated plainly:** no per-person revocation, no per-person audit trail at the auth layer, and a credential that will be shared over chat. Mitigate with 2FA, the audit log in [§5.5](#55-other-controls), and by treating in-platform onboarding as the first post-migration project rather than an indefinite "later".

**Attribution is not lost.** The app already separates *who is logged in* from *who did the work*: `submitted_by`, `sales_rep` and `appointment_setter` are dropdown fields on the debrief, not auth identities. Every report in Project 1 keys off those fields, so single-account login does not degrade a single number in the reporting.

### 5.2 Authorization — layer 1 (primary, in the backend)

- `role` is **not** stored in user-editable data. It lives in `app_user.role`, writable only by the service role or an admin endpoint. Never let a user set their own role — every other check depends on it.
- Route-level guards: `requireRole('admin')`, `requireRole('admin','sales_manager')`.
- Record-level guards implementing D2: reads open to any authenticated role; writes require author-or-manager.
- Both encoded once as reusable middleware, and **tested directly** ([§8.3](#83-security-tests-backend-non-negotiable)).

### 5.3 Authorization — layer 2 (defense in depth, in Postgres)

Keep RLS enabled on every table. Under D11 this protects less than it would in a multi-user system — there is one identity, so there is no rep-versus-rep tampering to prevent. Its value now is (a) scaffolding that is already correct when onboarding lands, and (b) containment if the backend is ever compromised. Build it, but do not let it substitute for the controls in [§5.1](#51-authentication-single-account).

The backend connects as a **non-superuser application role** and sets the request's identity per transaction:

```sql
SET LOCAL request.jwt.claims = '{"sub":"…","role":"outside_sales_rep","email":"…"}';
```

RLS policies mirror D2. If a backend handler forgets an ownership check, the database still refuses the write.

Jobs that legitimately cross users (sync, import) use an explicit **service connection**. That path must be:
- narrow — only job handlers, never request handlers,
- obvious in code — a separately named client, e.g. `dbService` vs `dbUser`,
- audited — every use logged with the job id.

### 5.4 Secrets

| Secret | Lives in | Never |
|---|---|---|
| `LEAP_API_TOKEN` | `backend/.env` | any `VITE_*` var, any frontend file |
| Google **service account key** (JSON) | `backend/.env` / secret manager | the repo, the database in plaintext |
| `ANTHROPIC_API_KEY` | `backend/.env` | frontend |
| Postgres connection string | `backend/.env` | frontend, and the DB port is never published |
| Session signing secret | `backend/.env` | frontend |
| Backup encryption key | secret manager, **stored off the VPS too** | the same disk as the backups |

Rules: no secrets in the repo; `.env.example` documents names only; rotate `LEAP_API_TOKEN` at cutover since it has been held by a third-party platform; add a CI secret-scanning step.

### 5.5 Other controls

- Restrict `inspectLeapSchema` / `testLeapConnection` to **admin only**.
- Rate-limit auth endpoints and the import endpoint.
- Structured audit log for privileged actions: role changes, deletes, sheet pushes, sync commits.
- Postgres PITR enabled; verify a restore before cutover.
- PII (`customer_name`, `phone`, `email`, `address`) stays server-side; keep it out of logs and error payloads.

---

## 6. Repository structure

```
allied-sales-sync/
├─ frontend/                 # React + Vite — today's src/, essentially unchanged
│  ├─ src/
│  │  ├─ api/                # the compatibility shim lives here
│  │  ├─ components/
│  │  ├─ pages/
│  │  └─ hooks/
│  └─ package.json
│
├─ shared/                   # ONE copy of the business rules
│  ├─ src/
│  │  ├─ classification/     # sales-appointment + division rules (consolidates 4 copies)
│  │  ├─ kpi/                # KPI engine
│  │  ├─ matching/           # appointment resolution + dedupe keys
│  │  ├─ marketing/          # source taxonomy
│  │  ├─ insurance/
│  │  └─ constants/
│  └─ package.json
│
├─ backend/
│  ├─ src/
│  │  ├─ routes/             # REST API
│  │  ├─ middleware/         # auth, authz, error handling
│  │  ├─ jobs/               # leap sync, sheets push, import
│  │  ├─ integrations/       # jobprogress/, sheets/, anthropic/
│  │  ├─ db/                 # drizzle schema, migrations, RLS policies
│  │  └─ config/
│  ├─ tests/
│  └─ package.json
│
├─ e2e/                      # Playwright
├─ package.json              # npm workspaces root
└─ MIGRATION_PLAN.md
```

Wired with **npm workspaces** — no extra build tooling. `shared/` is consumed by both sides as a normal workspace dependency.

`src/lib/` is already dependency-free plain JavaScript, so it becomes `shared/` essentially by moving it. That's the payoff of D3/D6.

---

## 7. Data model

Eight tables: `appointment`, `debrief`, `list_option`, `marketing_source`, `appointment_import_exclusion`, `sync_run`, `sync_conflict`, `app_user`.

### 7.1 Translation notes

- Base44 auto-populates `created_by` (email). In Postgres this needs a column default or trigger — **the write-own policy silently fails without it.**
- Keep `id` as UUID. Preserve existing ids during migration so `appointment_id` references survive.
- Base44 `format: "date"` → `date`; `format: "date-time"` → `timestamptz`.
- Money (`sale_amount`, prices) → `numeric(12,2)`, **not** float.
- Add `created_at` / `updated_at` with a trigger.

### 7.2 Constraints that fix bugs

```sql
-- Kills the duplicate-appointment bug in both import and sync.
-- Mirrors canonicalAppointmentKey() in shared/matching.
ALTER TABLE appointment
  ADD CONSTRAINT appointment_identity_uniq
  UNIQUE (crm_lead_id, appointment_date, appointment_time);
```

Paired with `INSERT … ON CONFLICT DO UPDATE`, import and sync become genuinely idempotent regardless of how many records exist.

Indexes for the real query patterns:

```sql
CREATE INDEX ON appointment (appointment_date);
CREATE INDEX ON appointment (crm_lead_id);
CREATE INDEX ON debrief (appointment_date);
CREATE INDEX ON debrief (sales_rep);
CREATE INDEX ON debrief (crm_lead_id);
CREATE INDEX ON sync_run (mode, status, finished_at DESC);
```

### 7.3 KPI correctness — two steps, in order

1. **Paginate** so the aggregation receives complete data. Correctness restored with zero logic changes.
2. **Then** move heavy aggregations into SQL views *only if* pages are slow.

> Resist rewriting the KPI rules in SQL. That logic is subtle, load-bearing, and works. Step 1 is the fix; step 2 is an optimization.

---

## 8. Testing strategy (TDD)

Test-first, with one technique doing most of the heavy lifting.

**Runner:** Vitest across all three workspaces (same config idiom as the Vite setup already in use).

### 8.1 The golden-master approach — do this first

This is how 1,750 lines of subtle business logic migrate without silently changing anyone's commission numbers.

**Before touching anything:**

1. Export a representative production snapshot (anonymise PII).
2. Run today's `kpi.js`, `appointmentClassification.js` and `insurance.js` over it.
3. Commit the outputs as fixtures — `shared/tests/fixtures/golden/*.json`.
4. Write tests asserting the new implementation reproduces them **exactly**.

Any divergence is then either a bug you just caught, or a deliberate fix you consciously re-baseline. Nothing changes silently. This directly de-risks signed-month attribution, split-rep crediting and two-leg eligibility — the three rules most likely to break invisibly.

### 8.2 Unit tests — `shared/` (highest value)

Pure functions, no I/O. **Target ≥90% coverage; this is the crown jewels.**

Priority cases:
- **Classification consolidation** — a table-driven test proving one implementation now satisfies every call site the four copies used to serve. Include `"ROOF INSPECTION EST"`, `"WARRANTY EST"`, `"ROOF EST"`, `"MISC EST"`, untitled.
- Two-leg eligibility across division × appointment type × outcome.
- Signed-month attribution: July appointment + August signed date → August sale, July demo.
- Split-rep crediting: credited sales and revenue must sum to the team total, never inflate it.
- `canonicalAppointmentKey` — same job ID on a different date/time is a *different* appointment.
- Date-range boundaries in `inDateRange` (quarter/week edges, DST).

### 8.3 Security tests (backend, non-negotiable)

Authorization is a feature; test it like one.

- A rep **cannot** update another rep's debrief — asserted at both layers (API 403, and RLS refusal with the guard removed).
- A rep **cannot** set their own `role`.
- An unauthenticated request to every route returns 401.
- `sales_manager` cannot reach admin-only routes (sync, schema inspection).
- A user cannot push another user's debrief to Sheets.
- Expired/tampered JWTs are rejected.

Run against a **real Postgres** via Testcontainers. Mocking the database would test nothing here.

### 8.4 Contract tests

The compat shim's surface is load-bearing for 84 call sites. Lock it:

- `list("-created_date", 500)` returns descending, respects limit.
- `filter({category:"sales_rep"})` equality semantics match today.
- `invoke()` returns `{ data }` — `ImportAppointments` and `JobProgressSync` both read `response.data`.
- Row limits are set explicitly (defaults silently truncate).

### 8.5 Integration tests

- **Import idempotency:** import the same file twice → zero duplicates. This is the regression test for [§3.2](#32-correctness-bugs-the-migration-fixes).
- **Sync idempotency:** two consecutive commits over the same window → no new rows.
- JobProgress client: pagination, 429 backoff, partial failures — against a mocked HTTP layer.
- Sheets upsert: header-name mapping, and **never writing beyond column AN** (AO:BF hold ARRAYFORMULAs).
- `sync_run` / `sync_conflict` rows are actually written.

### 8.6 Frontend and E2E

Frontend unit tests only where logic lives — `SubmitDebrief` validation (required fields, split-% totalling 100), not exhaustive component coverage.

Playwright E2E on the critical paths only:
1. Log in → land on Today
2. Submit a debrief → appears in the queue, appointment marked Submitted
3. Import a spreadsheet → counts reconcile
4. Each dashboard renders with correct headline numbers

### 8.7 Definition of Done

A story is done when:
- [ ] Tests written **first**, red before green
- [ ] Unit + integration tests pass; golden-master unchanged (or re-baselined with written justification)
- [ ] Security tests cover any new endpoint
- [ ] No new lint errors; TypeScript strict passes
- [ ] Migrations are reversible and tested both directions
- [ ] Secrets audit: nothing new in `VITE_*`
- [ ] Reviewed by someone who didn't write it

### 8.8 CI gates

On every PR: lint → typecheck → unit → integration (ephemeral Postgres) → build → secret scan. Block merge on failure. E2E runs on merge to main.

---

## 9. Sprint plan

Two-week sprints. **Sizes are relative effort, not calendar commitments** — actual duration depends on team size and how much of it is dedicated.

### Sprint 0 — Foundations and safety net

*Goal: the harness exists before any migration code does.*

- **`git init`, first commit, push to the private remote** — the working copy is not under version control today, and everything below depends on it
- Deploy and verify Phase 0 hardening (**verify user registration still works** — see [§3.1](#31-fixed-already-phase-0-applied-2026-08-29))
- Restructure into `frontend/` + `shared/` + `backend/` workspaces; move `src/lib/` → `shared/` unchanged
- Vitest + CI pipeline + secret scanning
- **Capture golden-master fixtures from production data** ([§8.1](#81-the-golden-master-approach--do-this-first))
- `npm run lint:fix`; delete `OAuthConsent.jsx` and `StatTable.jsx`
- *(Removed: Google OAuth verification is no longer required — see [§4.5](#45-google-sheets-uses-a-service-account-not-oauth))*

**Exit:** code in version control, CI green, golden fixtures committed, nothing functionally changed.

### Sprint 1 — Data model  ✅ DELIVERED

*Goal: a real database with the bugs designed out.*

Built and verified against a live PostgreSQL 17. 53 backend tests pass, including
20 RLS security tests and 8 identity/idempotency tests.

| Deliverable | Where |
|---|---|
| 4 reversible SQL migrations (+4 down) | `backend/migrations/` |
| 8 tables, 208 columns | `0002_core_tables.up.sql` |
| Identity constraint + 15 indexes | `0003_identity_and_indexes.up.sql` |
| RLS policies + column-level grants | `0004_rls_policies.up.sql` |
| Migration runner (checksums, advisory lock, up/down) | `src/db/migrate.ts` |
| Split app/jobs pools with per-transaction identity | `src/db/client.ts` |
| Drizzle schema, generated from the migrated DB | `src/db/schema/index.ts` |
| Base44 export importer | `scripts/import-base44-export.ts` |
| Encrypted backup + rehearsed restore | `scripts/backup.sh`, `restore-rehearsal.sh` |
| Postgres 16 + pgvector, private network only | `docker-compose.yml` |
| CI runs the DB tests against a real Postgres service | `.github/workflows/ci.yml` |

**Two defects found by writing the tests, both fixed:**

1. **`REVOKE UPDATE (role)` does not work.** A table-level `GRANT UPDATE` implies
   every column, and a column-level revoke cannot claw it back —
   `has_column_privilege()` still returned true. The privilege-escalation guard
   is now a **narrow column-list GRANT**, which PostgreSQL does enforce.
2. **The importer overwrote `created_at` and `created_by` on conflict.** When a
   duplicate export row merged into an existing appointment, it rewrote when the
   record was created and who created it — the latter being exactly what the
   write-own policy compares against. Provenance columns are now immutable on
   merge; business fields still take the newer value.

**Still outstanding (blocked on prerequisites, not on code):**

- Loading real production data — needs the export (P2).
- Running the backup to real offsite storage and recording a rehearsed restore —
  needs credentials (P7). **Still a cutover blocker.**
- `pgvector` is installed by the compose image; the local PostgreSQL used for
  these tests does not have it, so migration `0001` skips it with a notice.

### Sprint 2 — Auth (single account)  ✅ BACKEND DELIVERED

*Goal: the one shared login works, and multi-user drops in later without a rewrite.*

97 backend tests pass against a live PostgreSQL, 44 of them covering auth alone.

| Deliverable | Where |
|---|---|
| Sessions, lockout, TOTP state, audit trail | `migrations/0005_sessions_and_auth.up.sql` |
| argon2id hashing, token generation, timing-safe compare | `src/auth/crypto.ts` |
| Session lifecycle: idle + absolute expiry, rotation, revocation | `src/auth/session.ts` |
| TOTP enroll/verify with replay guard; lockout; audit | `src/auth/account.ts` |
| Session auth, CSRF, `requireRole()` seam | `src/middleware/auth.ts` |
| Login / logout / me / TOTP routes — **no registration route** | `src/auth/routes.ts` |
| Account provisioning (password read from stdin, never argv) | `scripts/seed-user.ts` |
| Google sign-in buttons deleted; register/forgot/reset unrouted | `frontend/src/pages/`, `App.jsx` |

**Controls worth naming, because each closes a specific attack:**

- **Session tokens are stored hashed.** A dump of the `session` table grants nobody a session.
- **Two expiries.** Idle (12h, slides) and absolute (7d, fixed at login) — so a
  continuously-used session still cannot live forever. A test asserts the slide
  is clamped to the wall.
- **Uniform failure responses.** "No such account", "wrong password" and "wrong
  code" are indistinguishable to the client, and a dummy argon2 verify runs when
  the account is missing so response *timing* does not leak either.
- **TOTP codes are single-use.** A code stays valid for its whole 30-second step;
  recording the highest accepted step makes a captured code unusable twice.
- **Two throttles, different attacks.** Per-IP rate limiting slows a spray across
  many accounts; per-account lockout stops a focused guess at one.
- **CSRF bound to the session**, so a token minted for another session is refused.
- **No registration surface.** Six candidate URLs are asserted to 404 — absent,
  not merely guarded.

**Deferred deliberately (D20):** the `AuthContext.jsx` rewrite. Doing it now
would leave the frontend authenticating against our backend while every data call
still goes to Base44 — a half-migrated app that works with neither. It lands in
Sprint 3 alongside the data shim, in the same commit that renames
`base44Client.js` to `client.js` (its contents stop being Base44 at exactly that
moment, so the name and the implementation change together).

### Sprint 3 — Read APIs and the shim  ✅ CODE DELIVERED

*Goal: dashboards render from our backend.*

192 tests pass repo-wide (129 backend). The frontend now talks exclusively to our
API — `base44Client.js` is deleted and all 31 importing files were repointed.

| Deliverable | Where |
|---|---|
| Entity allowlist: tables, roles, legacy aliases | `src/entities/registry.ts` |
| Paginated, parameterised query layer | `src/entities/repository.ts` |
| REST routes with per-operation role checks | `src/entities/routes.ts` |
| HTTP transport: same-origin, CSRF, central 401 handling | `frontend/src/api/http.js` |
| The shim — same shape, our backend | `frontend/src/api/client.js` |
| `AuthContext` rewritten against session auth | `frontend/src/lib/AuthContext.jsx` |
| Login wired to `useAuth`, TOTP step added | `frontend/src/pages/Login.jsx` |
| 33 contract + security tests | `tests/entities.test.ts` |

**Why the generic entity API is acceptable here, and what keeps it safe.**
Its shape is dictated by the shim's contract, not by good API design — that is
the trade that let 31 files move backends without a rewrite. Because it is
generic, the allowlist is load-bearing:

- **Identifiers come from `information_schema` at boot.** Client input is only
  ever *compared* against that set, never concatenated. Four injection payloads
  through `sort` and one through a filter key are tested.
- **An unknown sort or filter field is a 400**, never silently ignored — a
  dashboard quietly sorted by the wrong column is worse than an error.
- **Generated columns are unwritable**; a forged `identity_key` is discarded and
  the database's own value returned.
- **`password_hash`, `totp_secret` and `csrf_token_hash` are never selectable.**
- **`User` create/update/delete are not exposed** (405) — exposing them would
  rebuild the registration surface Sprint 2 removed.
- **RLS still applies underneath**: a rep editing another rep's debrief gets 404,
  not 403, because confirming the row exists would itself leak.

**Pagination is stable.** `ORDER BY <field>, id` — without the tiebreaker, rows
sharing a `created_at` can swap between pages and be returned twice. Tested by
paging 25 rows in steps of 7 and asserting 25 distinct ids.

**Still outstanding:**

- `/api/functions/:name` and `/api/files/upload` do not exist yet (Sprint 5), so
  Import Appointments and JobProgress Sync will 404 until then. Everything else
  reads from our backend.
- The **KPI reconciliation against Base44** — the sprint's actual exit criterion —
  needs the production data export (P2). The code is ready for it; the
  comparison is not something that can be faked.

### Sprint 3.5 — End-to-end smoke test  ✅ DONE

Run before Sprint 4 because four sprints had been delivered without the
application ever being started. Unit and integration tests exercise the backend
through `inject()`; they cannot catch anything that only breaks over a real
network with a real browser.

It found four problems, one of which was blocking:

| Found | Severity |
|---|---|
| **No `/api` proxy in the Vite dev config.** `@base44/vite-plugin` had been providing it. Every API call would have 404'd in development | **Blocking** |
| Removing that plugin also removes the `@` path alias it supplied — every import in the project would have broken | **Blocking** |
| `scripts/seed-user.ts` hung on piped input (a second readline interface finds stdin already consumed) and echoed the password to the terminal | High — the account could not be provisioned non-interactively |
| `index.html` still titled "Base44 APP"; `@base44/sdk`, `@base44/vite-plugin`, `app-params.js` and the orphaned `OAuthConsent.jsx` still present | Cosmetic / dead weight |

All fixed. `vite.config.js` now owns the alias and proxies `/api` to the backend,
matching the same-origin production topology (§10.1) so cookies and CSRF behave
identically in both environments.

**Verified working end to end**, through the real HTTP stack and the dev proxy:

- login → `Set-Cookie` with an HttpOnly session plus a readable CSRF token;
- `/api/auth/me` returns the user with cookies, 401 without;
- pagination across 1,250 seeded rows: 1000 + 250, `hasMore` correct;
- the legacy `created_date` alias present and equal to `created_at`;
- descending sort honoured; unknown sort field and a SQL-injection payload both 400;
- CSRF: write without the header 403, with it 201;
- Vite resolves `@/...` and `@allied/shared/...` in the browser module graph.

**Browser verification (second pass, extension connected).** Driving the real UI
found two more bugs that no test had caught — one of them the most serious defect
in the migration so far:

| Found | Severity |
|---|---|
| **Infinite redirect loop on load.** The global auth gate in `App.jsx` ran *before* `<Routes>`, so `/login` never rendered — it redirected instead, encoding the current URL (already carrying a `returnTo`) into a new one on every pass. The app spun on a URL doubling in length and rendered blank. It only worked on Base44 because `redirectToLogin` left the SPA for an external URL | **Blocking — the app did not load at all** |
| **Dates shifted a day, silently.** node-postgres parses a SQL `date` into a JS Date at *local* midnight, so on this UTC+5 machine `2026-07-20` was served as `2026-07-19T19:00:00.000Z` — wrong day, wrong *month* on the first of one. `inDateRange()` then does `new Date(value + "T00:00:00")`, which on an ISO string is `Invalid Date`, so the row is **dropped from the aggregate rather than counted wrongly**: every date-driven KPI would simply read low | **Critical — would have corrupted the KPI reconciliation** |

Both fixed, both with regression tests (`ORDER BY` now derives its expected count
rather than hardcoding it, and three tests pin date handling including a
New-Year's-Day round trip, where a backwards shift changes the *year*).

**Verified in a real browser, signed in as the seeded account:**

- login renders, authenticates, and lands on `/submit` with a clean URL;
- the D11 removals are visibly gone: no Google button, no "Create one", no "Forgot password?";
- the admin-only *JobProgress Sync* nav item appears for an admin, confirming role gating reaches the UI;
- **Appointment Records reports "1250 total"** — under the old 500-row cap this
  read 500. The pagination fix is demonstrably working against real page loads;
- dates render as `2026-07-20`, not a shifted ISO timestamp;
- the KPI Dashboard renders all 32 cards and the aggregation runs without error
  (zeros are correct — only appointments were seeded, no debriefs).

---

### Sprint 4 — Writes and consolidation  ✅ DELIVERED

*Goal: the app is fully usable; the four keyword lists become one.*

271 tests pass repo-wide. Writes and author-or-manager enforcement had already
landed in Sprint 3, so this sprint was the consolidation and file upload.

**The four keyword lists are now one.** `shared/src/nonSalesActivity.js` holds the
single definition; `salesAppointment.js` and `appointmentClassification.js` both
consume it. The bug is demonstrably fixed — `ROOF INSPECTION EST` and
`WARRANTY EST` now classify identically through both paths, where before they
contradicted each other.

The merge was decided on evidence rather than preference (D23). Voting across the
four copies:

| Support | Keywords |
|---|---|
| 4 of 4 | `customer service`, `sample`, `solar`, `walk through`, `walk thru`, `wcb` |
| 3 of 4 | `collection`, `inspection`, `material delivery`, `measurement`, `production`, `unassigned`, `warranty` |
| 2 of 4 | `install`, `measure`, `walkthrough` |
| 1 of 4 | `call back`, `callback`, `warranty callback` |

Taking the union keeps behaviour that exists today and adds nothing new to the
exclusion set except `unassigned` (3 of 4, and self-evidently not a sales visit).
`warranty callback` and `measurement` were dropped purely as redundant, since
matching is substring-based. **`callback` is flagged in the source as contested** —
one implementation of four, and `warranty` already covers the documented case. It
is retained so this change alters no live behaviour, but it wants validating
against real appointment titles and then deciding deliberately.

59 table-driven tests assert every consumer agrees on every keyword. The old
`classification-drift.test.js` was deleted, as its own docstring instructed once
the copies were unified.

**File upload** (`/api/files/upload`, `/api/files/:id`) replaces
`integrations.Core.UploadFile`, with migration 0006 for the metadata. These are
spreadsheets of customer appointments, so the posture is defensive: manager-only,
CSRF-protected, extension and content-type allowlists, size ceiling enforced
*after* the write because multipart truncates rather than throwing, generated
storage keys, and retrieval through an authenticated route rather than a static
directory.

**A real vulnerability found by its own test.** A filename containing a NUL byte
reached the database unsanitised and PostgreSQL rejected it outright ("invalid
byte sequence for encoding UTF8: 0x00") — turning a hostile upload into a 500.
NUL in a filename is also a long-standing path-truncation trick. Filenames are
now stripped of control characters and separators before storage, with tests.

**Not done, and worth stating plainly:** the merged keyword list has been
validated against *reasoning*, not against Allied's real appointment titles. That
validation needs the production export we chose to defer. Whether `callback`
belongs in the list is a business question this sprint could not settle.

### Sprint 5 — Jobs and integrations  ◐ PARTIALLY DELIVERED

*Goal: the automated pipelines run on our infrastructure.*

324 tests pass repo-wide (up from 271). The JobProgress rewrite is complete and
verified; the two credential-dependent integrations are not built, and say so.

**Delivered and verified**

| | Where | Tests |
|---|---|---|
| Sliding-window rate limiter | `src/integrations/jobprogress/rateLimiter.ts` | 8 |
| JobProgress client (rewrite, D14) | `src/integrations/jobprogress/client.ts` | 29 |
| Sync job with real telemetry | `src/jobs/syncJobProgress.ts` | 16 |
| `/api/functions/:name` dispatch | `src/functions/routes.ts` | — |

Every defect recorded in `docs/jobprogress-api.md` is fixed and pinned by a test
that names the section it came from:

- **§2.1 rate limit.** The old client paced at 200ms — 300 req/min against a
  documented 60, five times over, hidden by its own backoff. Now one shared
  sliding window (55/min by default, a deliberate margin). A sliding window
  rather than a token bucket because a bucket of capacity C still permits
  C + 60 inside some 60-second window; the test asserts the invariant across
  *every* window, and again under concurrent callers.
- **§2.2 `result_option_ids`.** The plural field is the one that exists; the
  singular is only a query parameter, so the old result counters were wrong.
- **§2.3 `.data` unwrapping.** The old client unwrapped `jobs` but read
  `customer`, `user` and `created_by` raw. `mapAppointment` now unwraps all of
  them, so phone, city, rep and setter populate.
- **§3.1 incremental sync.** Filters `appointment_updated_date` from the previous
  successful run, less a 30-minute overlap. An occurrence-date window
  structurally cannot see a result added today to a three-week-old appointment.
- **§3.2 signed sales.** One `contract_signed_date` query instead of fetching
  every job and testing each — which also removes most of the calls that pushed
  the old client over the limit.

**The dead telemetry is alive.** `sync_run` and `sync_conflict` have existed in
the schema since the beginning and nothing ever wrote to them, so the admin
screen has always read "Last Successful Commit: Never" with an empty exceptions
panel. Runs are now opened, closed with counts, and — importantly — **recorded
when they fail**, rather than vanishing. `incremental_since` is populated, which
is also what makes the watermark work.

**Idempotency is structural.** Upserts target `identity_key`, so a re-run cannot
duplicate. A test runs the same sync twice and asserts zero created, two updated.

**Not delivered — blocked on credentials, not on design**

| Item | Needs |
|---|---|
| Google Sheets push | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEETS_SPREADSHEET_ID`, and the sheet shared with the service account |
| Claude spreadsheet extraction | `ANTHROPIC_API_KEY` |
| The §2.3 / §2.4 live verification | `LEAP_API_TOKEN` — one real call settles whether contact and rep fields have been importing blank all along |

`/api/functions/:name` returns **501 with the specific missing configuration**
for both, rather than failing obscurely. Building integrations that cannot be
run against the service they integrate with would mean shipping untested code
against a third-party contract — the same mistake `docs/jobprogress-api.md`
exists to document.

**Also outstanding:** pg-boss is installed but not yet wired — the sync runs
in-request with a timeout for now, which is adequate for a manually triggered
admin action and not adequate for the scheduled job. Scheduling stays disabled
until that lands, which matches the plan's intent (UTC/DST handling in §4.3).

### Sprint 6 — Parallel run and cutover

*Goal: switch over without surprises.*

- Both backends live; Base44 authoritative, ours shadowing
- **Run through a full month-end close** — that's when the KPI logic is exercised hardest and divergence surfaces
- Observability: structured logs, error tracking, job dashboards
- Runbook + rollback plan; restore-from-backup rehearsed
- Cutover: password-reset comms → freeze → final data sync → DNS/config switch → smoke tests
- Rotate `LEAP_API_TOKEN`
- Enable the scheduled sync **only after** a clean manual run

**Exit:** production on the new stack; Base44 in read-only standby for one cycle, then decommissioned.

### Sprint 7+ — Platform work (post-migration)

Not part of the migration; enabled by it.

- `pgvector` schema + embedding pipeline for RAG
- Agent framework using `shared/` rules as tools
- Automation rules engine
- Replace the compat shim with a cleaner API client, incrementally
- Revisit the LLM spreadsheet parse — a deterministic parser plus a column-mapping step would be faster, cheaper and deterministic (it changes the import flow slightly, hence out of migration scope)

---

## 10. Deployment and operations

**Target: a single VPS**, served from a subdomain of the company domain.

### 10.1 Topology — one subdomain, not two

Serve the frontend and the API from the **same origin**:

```
https://sales.<company-domain>/          →  frontend static build
https://sales.<company-domain>/api/*     →  Node backend (reverse-proxied)
```

This is deliberate. A single origin means **no CORS configuration, no cross-site cookie problems, and no preflight overhead** — three classes of bug that appear immediately if the API lives on its own subdomain. Split them only if a separate mobile or third-party client appears later.

### 10.2 VPS layout

```
                    :443
                      │
              ┌───────▼────────┐
              │     Caddy      │   automatic TLS (Let's Encrypt), HTTP→HTTPS
              │ reverse proxy  │   serves /  → static build
              └───┬────────────┘   proxies /api → backend:3000
                  │
          ┌───────▼────────┐
          │  backend       │   Node 22 + Fastify (container)
          │  + pg-boss     │   jobs run in-process or a second worker container
          └───────┬────────┘
                  │  (private network only — never exposed publicly)
          ┌───────▼────────┐
          │   Postgres     │   see §10.3
          └────────────────┘
```

Run it with **docker compose**. Caddy is preferred over nginx here purely because it obtains and renews TLS certificates on its own — one less thing to forget.

**Firewall:** only 22, 80 and 443 open. Postgres and the backend port are never publicly reachable. SSH by key only, root login disabled, unattended security upgrades enabled, `fail2ban` on SSH.

**Sizing:** for ~10 users this is small. 2 vCPU / 4 GB RAM / 40 GB SSD is comfortable for Caddy + Node + Postgres, with headroom for the sync job. Revisit only if RAG embeddings arrive at volume.

### 10.3 Database: dedicated PostgreSQL

**Decided (D12): a dedicated PostgreSQL instance we own, running on the VPS.** No Supabase, no managed provider, no third-party account for the data layer.

- Postgres 16+ in the compose stack, on the private network only — **never a published port**.
- `pgvector` extension installed at provisioning time, so the RAG work in [§2.2](#22-future-workloads-this-must-support) needs no migration later.
- Dedicated database role for the application. It is **not** superuser and **not** the owner of the tables it queries.
- Tuned for the box: `shared_buffers`, `work_mem` and `max_connections` set deliberately rather than left at defaults, and a connection pool in the backend.

**This makes backups entirely our responsibility, and that is now a cutover blocker.** Concretely:

- Nightly `pg_dump`, encrypted, shipped **off the VPS** — a backup on the same disk as the database is not a backup.
- Retention: 7 daily, 4 weekly, 12 monthly.
- WAL archiving if point-in-time recovery is wanted; nightly dumps alone mean up to 24 hours of loss.
- **A restore rehearsed into a scratch database, with the result written down, before cutover.** Untested backups are the single most common way self-hosted projects lose data.
- Disk-space alerting — Postgres and WAL will fill a disk quietly and take the app down with them.

Owning the database also means owning minor-version upgrades and the security patches that come with them. Budget for that.

### 10.4 Environments

| Environment | Where |
|---|---|
| dev | Local: Vite dev server, backend on localhost, Postgres in Docker |
| staging | Same VPS, second compose stack on `sales-staging.<domain>`, separate database on the same Postgres instance |
| production | `sales.<domain>` |

Staging on the same box is acceptable at this scale and makes the parallel run in Sprint 6 cheap. Keep the databases strictly separate.

### 10.5 Release process

1. CI builds and tests on push (see [§8.8](#88-ci-gates)).
2. On merge to main, CI builds the backend image and the frontend static bundle.
3. Deploy by SSH: pull image, run migrations as a **gated, explicit step**, then restart the backend and swap the static bundle.
4. Migrations never run automatically on container boot — a crash-looping container must not repeatedly attempt schema changes.
5. Health check endpoint; roll back by redeploying the previous image tag.

### 10.6 Observability and backups

Structured JSON logs with request ids; error tracking (Sentry or equivalent); job success/failure metrics; alerts on sync failure and auth error-rate spikes. Disk-space alerting matters more on a VPS than on managed hosting — Postgres and logs will fill a disk quietly.

**Backups:** PITR if option A. If option B, nightly `pg_dump` encrypted to offsite storage, with retention. Either way: **rehearse a restore before cutover.** An untested backup is not a backup.

**Runbook** to write during Sprint 6: sync failed; import produced duplicates; Sheets push failing; user locked out; certificate renewal failed; disk full; rollback to Base44.

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ~~Google OAuth verification~~ | — | **Removed.** A service account needs no consent screen and no review ([§4.5](#45-google-sheets-uses-a-service-account-not-oauth)). Nothing in this plan is now gated on third-party review |
| ~~Everyone must reset their password~~ | — | **Removed by D11** — a single new account is provisioned at cutover; no per-user migration |
| **KPI divergence goes unnoticed** | Wrong commission numbers | Golden-master fixtures + side-by-side reconciliation in Sprint 3 + a full month-end parallel run |
| **`created_by` backfill wrong** | Write-own policy fails open or closed | Explicit backfill task in Sprint 1 with a reconciliation query; RLS tests would catch the failure |
| **`User.role` lock breaks registration** | Nobody can sign up | Test immediately after Phase 0 deploy; revert path documented in [§3.1](#31-fixed-already-phase-0-applied-2026-08-29) |
| **DST shifts the sync window** | Missed/duplicated syncs twice a year | Schedule UTC, handle offset explicitly, test both sides of the transition |
| **Secret leaks into the frontend** | Credential exposure | `VITE_*` rule in [§5.4](#54-secrets), CI secret scanning, review checklist item |
| **Shared credential leaks or is over-shared** | Full system access | D11 consequence. TOTP 2FA, audit log, rate limiting; in-platform onboarding prioritised straight after migration |
| **Backup never tested, data lost** | Unrecoverable | D12 consequence. Rehearsed restore is a **cutover blocker** — see [§10.3](#103-database-dedicated-postgresql) |
| **Historical CRM imports may hold blank contact/rep fields** | Reporting built on gaps | Suspected from the API spec (`docs/jobprogress-api.md` §2.3). One live call confirms or clears it — do this in Sprint 5's first task, or earlier if a token is available |
| **Scope creep into a frontend rewrite** | Migration never lands | The shim is the contract. UI changes are a separate project |

---

## 12. Open questions

1. **Team and cadence** — how many engineers, and is this full-time? Sprint sizes are relative until we know.
2. ~~Database hosting~~ — **answered: dedicated PostgreSQL on the VPS (D12).**
3. ~~Data residency~~ — **moot: data sits on our VPS.** Confirm the VPS region satisfies any customer commitment.
7. **Which phone system or dialer does the call centre use?** Blocks the Calls workstream in [§1.2](#12-what-project-1-already-has-and-what-it-doesnt) — that data has to come from somewhere.
8. **Who holds the shared credential, and how is it distributed?** D11 makes this a real operational question, not a formality.
4. **Data retention** — how long do we keep debriefs and appointment PII? Not currently defined anywhere.
5. **Does anyone rely on the Base44 Builder UI?** If a non-engineer edits the app there today, that capability disappears.
6. **Historical archive** — keep a Base44 export indefinitely, or migrate everything and delete?

---

## 13. Sprint 0 prerequisites

What the team needs from the business before Sprint 0 can finish. Ranked by what blocks what.

### Blocking — Sprint 0 cannot complete without these

| # | Need | Why | Notes |
|---|---|---|---|
| P0 | **Git hosting + the code pushed to it** | **This working copy is not a git repository.** There is no version control and no CI config. Sprint 0's deliverable is a CI pipeline, which cannot exist without a remote | GitHub or GitLab. Private. Comes with a free container registry and CI runner — see [A1](#131-accounts-and-services) |
| P1 | **Base44 dashboard access** (admin) | To deploy the Phase 0 hardening and export data | Either credentials for an engineer, or a named person who runs the deploy |
| P2 | **Production data export** — `Appointment`, `Debrief`, `ListOption`, `MarketingSource` | The golden-master fixtures depend on it. Without this the entire safety net in [§8.1](#81-the-golden-master-approach--do-this-first) doesn't exist | CSV or JSON. Needs a ruling on whether engineers may hold real PII, or whether it's anonymised first |
| P3 | **Google Cloud access** — create a project + service account for the **Sheets API** | Lets the backend write to the master spreadsheet. **Not user login** — see [§4.5](#45-google-sheets-uses-a-service-account-not-oauth) | No longer urgent: no verification review. Needed by Sprint 5. Also need someone who can share the spreadsheet with the service account |
| P4 | **Confirm Phase 0 deploy result** — specifically that **new-user registration still works** | The `User.role` lock is the one change we couldn't verify against docs | Revert path is documented in [§3.1](#31-fixed-already-phase-0-applied-2026-08-29) |

### Blocking Sprint 1 — needed within roughly two weeks

| # | Need | Why |
|---|---|---|
| P5 | **VPS access** — provider, specs, OS, SSH key, and whether it's fresh or already in use | Provisioning, firewall and compose stack |
| P6 | **Domain and DNS access** — the exact subdomain, plus who can create records | TLS issuance needs the DNS record live first |
| P7 | **Offsite backup storage** (S3/B2/equivalent) + credentials | Required by D12; the rehearsed restore is a cutover blocker — [§10.3](#103-database-dedicated-postgresql) |
| P8 | ~~Role roster~~ — **deferred by D11.** Needed for in-platform onboarding, not for the migration | The names in `constants.js` are dropdown seed data, not an access list. Revisit when onboarding is built |

### Blocking Sprint 5 — needed before integrations

| # | Need | Why |
|---|---|---|
| P9 | **JobProgress / Leap API token** | To test the sync against a real account. Confirm who holds it today and that it can be rotated at cutover |
| P10 | **Google Sheets spreadsheet ID and structure** | `pushDebriefToSheet` maps by exact header text and must never write past column AN (AO:BF hold `ARRAYFORMULA`s). We need the real header rows for "Debrief Responses" and "Lead Sheet" |
| P11 | **Anthropic API key** | Replaces the Base44 AI extraction in the import flow |

### 13.1 Accounts and services

Every third-party account the project depends on, and when it's needed. **All of these must be owned by a company identity with at least two admins** — not an engineer's personal account. Offboarding or a single unavailable person should never be able to lock you out of your own production system.

| # | Service | Needed by | Required? |
|---|---|---|---|
| A1 | **Git hosting** (GitHub / GitLab, private) | Sprint 0 — blocking | **Yes.** Nothing else works without it |
| A2 | **CI runner + container registry** | Sprint 0 | **Yes**, but included free with A1 — no separate account |
| A3 | **Google Cloud project** (service account, Sheets API) | Sprint 5 | **Yes** — for writing to the master spreadsheet. Not login. No review required |
| A4 | **VPS** | Sprint 1 | **Yes** |
| A5 | **DNS / domain registrar access** | Sprint 1 | **Yes** — TLS issuance needs the record live |
| A6 | ~~Supabase~~ | — | **No longer required (D12).** The data layer is self-hosted; there is no Supabase account |
| A7 | **Anthropic API** | Sprint 5 | **Yes** — replaces the Base44 AI extraction |
| A8 | **Offsite backup storage** (S3/B2/equivalent) | Sprint 1 | **Yes — required by D12, and a cutover blocker.** See [§10.3](#103-database-dedicated-postgresql) |
| A9 | **Error tracking** (Sentry or equivalent) | Sprint 6 | Optional; a self-hosted alternative works |

#### On A6 — no Supabase account is needed

Superseded by D12. The data layer is a dedicated PostgreSQL instance we run ourselves, and D11 removed the auth service that was the other reason to have an account. **Nothing in this plan requires signing up for Supabase.**

The trade is explicit: you gain full ownership and one fewer vendor; you take on backups, restore rehearsals, tuning and minor-version upgrades. A8 and the backup obligations in [§10.3](#103-database-dedicated-postgresql) are how that trade is paid.

### Decisions we need, not access

- Open questions 1, 3, 4, 5 and 6 in [§12](#12-open-questions).
- A named product owner who can arbitrate when the golden-master reconciliation in Sprint 3 finds a KPI difference — someone has to decide whether it's a bug being fixed or a number being changed.

---

## Appendix: measured inventory

Facts gathered from the codebase, not estimates.

**Coupling surface — 84 `base44.*` call sites:**

| Call | Count |
|---|---|
| `entities.<E>.list` | 29 |
| `entities.<E>.update` | 13 |
| `auth.me` | 8 |
| `entities.<E>.filter` | 5 |
| `entities.<E>.delete` | 5 |
| `entities.<E>.create` | 4 |
| `functions.invoke` | 3 |
| other auth (11 methods) | 6 |
| `integrations.Core.UploadFile` | 1 |
| `entities.<E>.get` | 1 |

**Entities used from the frontend:** `Debrief` 22, `Appointment` 21, `ListOption` 11, `User` 1, `SyncRun` 1, `SyncConflict` 1.

**Portable business logic — `src/lib/`, ~1,750 lines, zero Base44 imports:**

| File | Lines |
|---|---|
| `kpi.js` | 729 |
| `insurance.js` | 262 |
| `constants.js` | 221 |
| `appointmentClassification.js` | 196 |
| `marketingSources.js` | 151 |
| `salesAppointment.js` | 74 |
| `appointmentMatching.js` | 70 |
| `appointmentTypes.js` | 49 |

**Backend to port — ~1,450 lines of Deno TypeScript:**

| Function | Lines |
|---|---|
| `syncLeapJobProgress` | 527 |
| `importAppointments` | 421 |
| `pushDebriefToSheet` | 376 |
| `inspectLeapSchema` | 112 |
| `testLeapConnection` | 99 |

**Frontend:** 17 routed pages, 25 app components, 50 shadcn/ui components.

**Platform limits worth remembering:** Base44 caps `list()`/`filter()` at 5,000 rows per request; the app self-caps at 500.
