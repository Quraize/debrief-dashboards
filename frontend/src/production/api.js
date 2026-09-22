// Production API client. Self-contained on purpose: if the production
// department gets its own front end later, this file moves with it.
import { get, post, qs } from "@/api/http";

export const productionApi = {
  /** The board for one day (`{ date }`) or a short range (`{ from, to }`). */
  board: (params) => get(`/api/production/board${qs(params)}`),
  /** Pull the production calendar (and the jobs by stage) from JobProgress right now. */
  refresh: () => post("/api/production/sync"),
  /** Sold-Job Pipeline: every signed job not yet paid, bucketed, with the CEO's totals. */
  pipeline: () => get("/api/production/pipeline"),
  /** Production's Blocker / Owner / Next Action for one job. Empty string clears a field. */
  pipelineNote: (jobId, { blocker, owner, nextAction }) => post(`/api/production/pipeline/${encodeURIComponent(jobId)}/note`, { blocker, owner, nextAction }),
  /** Every job in a tracked workflow stage, grouped like the JobProgress Jobs screen. */
  jobs: () => get("/api/production/jobs"),
  /** The same jobs as rows of the production master sheet's WEEKLY JOB SHEET tab. */
  weeklyJobSheet: () => get("/api/production/weekly-job-sheet"),
  /** Google Sheet push: configuration and the last run. */
  sheetPushStatus: () => get("/api/production/weekly-job-sheet/push"),
  /** Preview (dry run) or perform the push into the [AUTOMATION] tab. */
  sheetPush: ({ dryRun }) => post("/api/production/weekly-job-sheet/push", { dry_run: dryRun }),
};
