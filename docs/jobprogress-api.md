# JobProgress / Leap API — verified reference

Source: <https://docs.api.jobprogress.com> (OpenAPI spec, `generatedAt 2025-08-28`, 51 endpoints across 28 tags).
Read on 2026-08-30, before porting `syncLeapJobProgress` in Sprint 5.

Findings are marked **[confirmed]** where the spec states it outright, and **[verify live]** where the
documented example implies it but one real API response should settle it before we rely on it.

---

## 1. Fundamentals — what the current client already gets right

| Thing | Spec | Our client |
|---|---|---|
| Base URL | `https://api.jobprogress.com/api/v3` | same |
| Auth | `Authorization: Bearer YOUR_ACCESS_TOKEN` | same |
| Page size | `limit`, **max 100** (default 10) | `limit=100` |
| Pagination | `meta.pagination.{total,count,per_page,current_page,total_pages}` | reads `total_pages` |
| Envelope | `{ data, meta, status }` | correct |
| Appointment `includes[]` | `user, attendees, jobs, result_option, reminders, customer, created_by, attachments` | sends 6, all valid |
| Job `includes[]` | `address, estimators, reps, customer, sub_contractors, projects, work_types, trades, division, deleted_by, financial_details, custom_fields…, flags, insurance_details` | sends 8, all valid |
| Division `includes[]` | `address, users, trades, work_types, settings` | sends 2, valid |
| `duration` | enum `date` / `upcoming` / `today` | `duration=date` |
| Financial summary | `GET /jobs/{jobId}/financial_summary` | same (underscore) |
| Job batching | `job_ids[]` on `GET /jobs` | correct |

Access tokens are generated at **Settings → Developer**, and **only admin users can create them** —
relevant to prerequisite P9 in the migration plan.

---

## 2. Defects in the current implementation

### 2.1 Rate limit exceeded by 5x — [confirmed]

The spec states plainly: **60 API requests per minute**, then 429.

`syncLeapJobProgress` sets `CALL_DELAY_MS = 200`, which is **300 requests/minute**. The exponential
backoff hides this — the sync appears to work while being throttled continuously.

**Fix:** a real limiter at 60/min (1000 ms spacing, or a token bucket at 1 rps). The sequential
`financial_summary` call per signed job makes it worse; §3.2 removes most of those.

### 2.2 `result_option_id` does not exist on the appointment object — [confirmed]

The appointment object exposes **`result_option_ids`** (plural array). `result_option_id` (singular)
is only a *query filter parameter*. Our code:

```js
const hasResult = (Array.isArray(apiAppt.result) && apiAppt.result.length > 0)
  || apiAppt.result_option_id != null;   // always undefined
```

So `appointment_results_available` and `appointment_results_missing` are both wrong — only the
`result` array path ever counts.

### 2.3 Included resources are wrapped in `.data` — [verify live]

The documented example nests an included relation as `"group": { "data": { … } }`. Our client
unwraps this correctly for jobs (`jobs.data`) but reads three others **unwrapped**:

```js
const customer  = apiAppt.customer   || {};   // likely {data:{…}}
const user      = apiAppt.user       || {};
const createdBy = apiAppt.created_by || {};
```

If the wrapper applies uniformly, then `phone`, `email`, `address`, `city`, `original_sales_rep`
and `original_appointment_setter` are **silently imported blank**. Confirm against one live response
before porting — cheap to check, expensive to miss.

### 2.4 `created_at` is not a documented appointment field — [verify live]

It appears only as a `sort_by` option, not in the response object. `mapApiToBase44` sets
`appointment_set_date` from `apiAppt.created_at`, which may therefore always be empty.

### 2.5 `with_job=1` — [confirmed, cosmetic]

Documented as a boolean. Send `true`.

---

## 3. Capabilities we are not using

### 3.1 True incremental sync via `date_range_type` — [confirmed]

`GET /appointments` accepts `date_range_type` of `appointment_created_date` or
**`appointment_updated_date`**.

The current workflow polls a **fixed occurrence-date window** (yesterday through today) every 30
minutes. That design **cannot see a result added today to an appointment held three weeks ago** —
which is exactly how debrief results arrive in practice.

Using `date_range_type=appointment_updated_date` with `start_date` = last successful run gives a
genuine incremental sync. Note the `SyncRun` entity already carries **`incremental_since`** and
**`checkpoint`** fields that nothing ever populates — they were designed for this and never wired up.

### 3.2 Query signed sales directly — [confirmed]

`GET /jobs` accepts `date_range_type` of `job_created_date`, `job_stage_changed_date`,
`job_completion_date`, **`contract_signed_date`**, `job_awarded_date`, **`job_updated_date`**,
`job_lost_date`, `job_invoiced_date`.

Today the sync finds signed sales indirectly: fetch appointments, extract job ids, fetch those jobs,
test `contract_signed_date`, then call `financial_summary` per signed job. With
`date_range_type=contract_signed_date` the signed set comes back in one paginated query. This serves
signed-month attribution (`effectiveSaleDate`) directly and removes most of the per-job calls that
push us over the rate limit.

### 3.3 Webhooks — [confirmed]

Events available: **Customer Create/Delete, Job Create, Job Stage Change, Job Delete, Job Lost,
Task Create/Complete.** Batched up to 100 notifications per POST, up to ~2 minutes' delay. A
non-200 response is retried at 3h and again at 24h; responses must arrive within 10 seconds.

Job stage changes and lost jobs become push rather than poll. **Appointment events are not on the
list**, so appointments still need polling — but this removes most job-side polling.

Fits the queue architecture in `MIGRATION_PLAN.md` §4.3: receive, enqueue, return 200 immediately,
process in a worker. Never process inside the webhook handler — the 10-second timeout is unforgiving.

### 3.4 Native appointment-result taxonomy — [confirmed]

- `GET /appointments/{id}/available_result_options`
- `GET /appointments/{id}/result` and `PUT /appointments/{id}/result`

Result options carry a **group** and typed **fields**:

```json
{ "id": 13, "name": "Sold test", "active": 1,
  "fields": [{"name": "Product", "type": "text"}, {"name": "Price", "type": "text"}],
  "group": { "data": { "id": 2, "name": "Sale", "color": "#3bc156" } } }
```

So the CRM already models sale-versus-no-sale (`group.name`), and result options can carry Product
and Price. That overlaps materially with `appointment_outcome` and parts of the debrief form — worth
evaluating before Project 1 extends manual data entry any further.

### 3.5 Marketing attribution at source — [confirmed]

`GET /jobs` supports `referred_type` (`all`, `referral`, `google`, `facebook`, `angi`, `thumbtack`,
`other`) and `referred_by` (referral source id). There is also a dedicated **Referrals** endpoint.

Project 1's marketing workstream has no spend data (§1.2 of the plan). This does not supply spend,
but it does give a **CRM-side source of truth for lead source** to reconcile against the app's own
14-category taxonomy — which today is populated by hand.

### 3.6 Server-side filters replacing client-side work — [confirmed]

`GET /appointments`: `division_ids[]`, `trades[]`, `work_types[]`, `category_ids[]`, `is_completed`,
`result_option_id`, `users[]`, `job_ids[]`, `cities[]`.
`GET /jobs` adds `stages[]`, `awarded_jobs`, `financial_status`, `flag_ids[]`.

Both support `sort_by` and `sort_order`. Set them explicitly (`sort_by=id&sort_order=asc`) so
pagination stays stable while records are being written underneath it.

---

## 4. Consequences for the plan

1. **Sprint 5 is a rewrite of the sync, not a port.** The rate limiter, the incremental strategy and
   the signed-sales query all change shape.
2. **Verify §2.3 and §2.4 against one live response first.** A single authenticated call settles
   both, and they determine whether historical imported data has blank contact and rep fields. If it
   does, that is a data-quality finding for Project 1, not merely a code fix.
3. **Rate limiting is a correctness issue, not tuning.** Build one shared limiter across every
   JobProgress call, since appointments, jobs, divisions and financial summaries all draw on the same
   60/min budget.
4. **Webhooks deserve an explicit design decision** in Sprint 5 rather than defaulting to polling.
