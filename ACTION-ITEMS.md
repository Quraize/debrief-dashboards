# Action items

Work that is planned but not being worked on right now. When we start an item,
take it out of this file; when it is done, it stays out.

---

## Level 10 Meeting Scorecard (from Pema, 2026-10-09)

Pema wants the EOS Level 10 meeting back as a non-negotiable weekly meeting:
one place where he sees the company's critical numbers and the department heads
review performance, solve issues and hold each other accountable. Goal: "less
time tracking numbers, more time improving them". Managers should not gather
data by hand.

- **Asked for:** a working V1 by Tuesday 2026-10-13 if possible. It does not need
  to be perfect or fully automated. Then automate and improve it.
- **V1:** a simple sheet with the top 10–15 company-wide KPIs. Later, a digital
  L10 dashboard.
- **Basis:** the original scorecard, which lost traction around March 2026
  (owners have left, goals out of date, #REF! errors). Pema suggested building a
  cleaner version of it.
  - Sheet: https://docs.google.com/spreadsheets/d/1VC-ANZet2L2suU6jmBmPS5tpppzKK5Pll_p4_RBLyLc/edit
  - Local CSV copies: `Downloads/Copy of LEVEL 10 Meeting 2026 - L10 SCORECARD 2026.csv`
    and `... - LEVEL 10 SCORECARD 2025.csv` (not in the repo).
- **Videos Pema shared:** EOS Level 10 Meeting Explained
  (https://youtu.be/1_iAxgB5k-k) and a digital L10 dashboard
  (https://youtu.be/f5KI1OHdA-E). Get the transcripts, plus screenshots of the
  dashboard in the second video.

**Proposed V1 (15 numbers) and their sources:**

| # | Number | Old goal | Source | Automatic? |
|---|---|---|---|---|
| 1 | New leads | 100/mo | JobProgress | Yes |
| 2 | Appointments set | | JobProgress + debriefs | Yes |
| 3 | Appt Set % | 85% | Dashboard funnel | Yes |
| 4 | Appointments ran (AR%) | 80% | Debriefs | Yes |
| 5 | 2-Leg % | 90% | Debriefs | Yes |
| 6 | Sales # and Close % | | Debriefs / JobProgress | Yes |
| 7 | Sales Gross $ | $400K/mo | JobProgress signed contracts | Yes |
| 8 | Gross Revenue Started | $320K/mo | Weekly Job Sheet | Yes |
| 9 | Installs completed | | Production calendar | Yes |
| 10 | Repairs / service completed | 3–5/wk | Production calendar | Yes |
| 11 | Callbacks: new and open | | Calendar (CB visits) | New yes; open/closed manual |
| 12 | Cash collected | | JobProgress payments | Yes |
| 13 | A/R total and over 30 days | | Revenue & AR page | Yes |
| 14 | Supplier A/P due this week | | AP Scorecard | Yes |
| 15 | Gross Profit % | 45% | Sheet cost block | Partly (Final JCC jobs only) |

Manual for now: 5-star reviews, safety training, meeting rating.

**Plan:** clean Google Sheet (owner, number, goal, rolling 13 weeks), back-filled
4–6 weeks from our data by a script; then filled automatically every Monday like
the AP Scorecard.

**Needed from Pema:** approve the list; an owner per row (e.g. Marco production,
Danny finance, Jason sales, Vanessa marketing); updated goals (Sept Gross Started
was $517K against the old $320K goal); a fresh file or a tab in the original;
OK for red/green marking (would be the first colour rule on a sheet we automate).

---

## Daily Expected Payments / Collections Report (from Pema, 2026-10-09)

Pema: a simple daily report showing which jobs should be bringing in money, how
much is due, and whether we have collected it, so Danny and Pema see expected
cash, outstanding payments and follow-ups without chasing several systems.
Source: the Weekly Job Sheet and the Production Calendar. Eventually automated
as part of production and financial reporting.

Pema's rules (verbatim intent):
- **Deposits:** every new install, repair or other job collects a 20%–50% deposit
  before we step on site, unless it is financed.
- **Progress payments:** every started job has its required deposit and the
  applicable progress payment accounted for.
- **Final payments:** any job with a completed MTC has its final payment collected
  or listed as outstanding. Due on the day of completion or within 24 hours.
- **September closeouts:** every job on September's Production Calendar is on the
  list and financially closed out by now, unless it is an ongoing multi-week MTC.

**Delivery idea (Iqrma):** connect our Unite Media and post the report
automatically each morning to a channel, e.g. Production Office or another
channel. Still to plan: which channel(s), how Unite Media accepts posts
(webhook / API / bot), what the message looks like (short summary + link to the
full list), and that customer names/amounts are fine for that channel's members.

**What already exists:** `tools/owed-today.mjs` sorts every balance into deposit /
progress / final; `apScorecard.ts` `completionDay()` works out the completion day
(Date Completed, else install start + MTC working days, Mon–Sat).

**Proposed sections:** Deposits due (no deposit, or under 20%, install coming;
late when install day arrives) · Progress payments (started jobs) · Final
payments (late more than 24 h after completion) · September closeouts (still
owing, not an ongoing MTC). Each row: job, JP link, due, collected, balance, days
late. Header: expected today, collected today, overdue.

**Questions to settle first:**
1. How to recognise a financed job (payment method, a field, a stage?).
2. The progress-payment rule (e.g. "50% when production starts"), or V1 flags only
   started jobs with no deposit until the progress-invoicing brief is agreed.
3. Flag deposits under 20% as short?
4. Output: Unite Media channel post (above) and/or a sheet tab
   [AUTOMATION]EXPECTED PAYMENTS; first a one-off server run to check numbers.

---

## Other open items (carried over)

- **Rock 1, Boomerang Revenue Engine:** feasibility done; pitch to Pema written
  (ask: approval for Phase 1, unsold demos). Review the "Rehash – Main" draft
  sequence before switching it on.
- **Six Boomerang questions** for Cameron / Vanessa (in the Boomerang Account Brief artifact).
- **$0 signed jobs on the Weekly Job Sheet:** option to keep them, marked "price not
  entered", instead of dropping them under "no money, no row". Waiting for the
  user / Marco to confirm. Do not build until confirmed.
- **Meeting outline and action items for the team** (Pema and Marco asked).
- **Pema's open items:** where No See / No Sale go; the review row title; whether
  "Pending / Not Updated" counts as Awaiting.
- **Danny:** start entering Commission Paid $ (column BX).
- **AP Scorecard:** two-week comparison with Pema's tab, then Pema switches off his
  Monday ChatGPT task.
- **Briefs Pema asked for:** production debrief form; AP form; progress invoicing
  for jobs over $30K; Jason's YTD by rep.
- **Check the "$4,300 last week" concern.**
- **Security:** rotate the JobProgress API token that was pasted in chat earlier.
