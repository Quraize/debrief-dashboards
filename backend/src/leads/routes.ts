/**
 * The top of the Overview funnel.
 *
 *   GET /api/leads/flow?from=YYYY-MM-DD&to=YYYY-MM-DD
 *     -> { leads, set, notSet, setRate, notSetRate, reasons: [{ key, label, count, share }] }
 *
 * Leads are jobs created in the range (office calendar days), insurance
 * excluded like every other box on the Overview. "Set" means a sales
 * appointment exists for the job; the rest are bucketed by their stage name
 * (shared/src/leadFlow.js). Counts only — no names leave the server — so it is
 * open to every signed-in role, and it reads as the service role because the
 * production role's RLS view of jp_job is not what a sales overview wants.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { withServiceRole } from "../db/client.js";
import { BOARD_TIMEZONE } from "../production/board.js";
import { leadFlow } from "@allied/shared/leadFlow";

interface FlowQuery { from?: string; to?: string }
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function registerLeadRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: FlowQuery }>(
    "/api/leads/flow",
    { preHandler: [requireAuth] },
    async (req: FastifyRequest<{ Querystring: FlowQuery }>, reply: FastifyReply) => {
      const { from, to } = req.query;
      if (!from || !to || !DAY.test(from) || !DAY.test(to)) return reply.code(400).send({ error: "from and to must be YYYY-MM-DD" });
      if (from > to) return reply.code(400).send({ error: "from must not be after to" });
      const rows = await withServiceRole(async (c) => {
        const { rows } = await c.query<{ current_stage: string | null; has_appointment: boolean }>(
          `SELECT j.current_stage,
                  EXISTS (SELECT 1 FROM jp_appointment a
                           WHERE a.crm_job_id = j.jp_job_id AND a.is_sales_type AND a.deleted_at IS NULL) AS has_appointment
             FROM jp_job j
            WHERE (j.jp_created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
              AND NOT j.is_insurance`,
          [from, to, BOARD_TIMEZONE]);
        return rows;
      }, "leads:flow", { quiet: true });
      return reply.send({ from, to, ...leadFlow(rows) });
    },
  );
}
