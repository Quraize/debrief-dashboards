// Production API client. Self-contained on purpose: if the production
// department gets its own front end later, this file moves with it.
import { get, post, qs } from "@/api/http";

export const productionApi = {
  /** The board for one day (`{ date }`) or a short range (`{ from, to }`). */
  board: (params) => get(`/api/production/board${qs(params)}`),
  /** Pull the production calendar (and the jobs by stage) from JobProgress right now. */
  refresh: () => post("/api/production/sync"),
  /** Every job in a tracked workflow stage, grouped like the JobProgress Jobs screen. */
  jobs: () => get("/api/production/jobs"),
};
