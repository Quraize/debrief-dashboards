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
