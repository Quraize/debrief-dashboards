/**
 * The Overview funnel, followed lead by lead.
 *
 *   GET /api/leads/flow?from=YYYY-MM-DD&to=YYYY-MM-DD
 *     -> leadFunnel(): leads, set / not set (+ reasons by stage), then per lead
 *        ran / no see / awaiting, demo / no demo / pending, sold / not sold.
 *
 * Leads are jobs created in the range (office calendar days), insurance and
 * warranty stages excluded. "Set" means a sales appointment exists for the
 * job. What happened next comes from the lead's debriefs, matched on the job
 * number the rep typed as the Lead ID (or the CRM job id when the debrief has
 * it). Only outcomes leave the server — no names — so it is open to every
 * signed-in role; it reads as the service role because the production role's
 * RLS view of these tables is not what a sales overview wants.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { withServiceRole } from "../db/client.js";
import { BOARD_TIMEZONE } from "../production/board.js";
import { leadFunnel } from "@allied/shared/leadFlow";

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
        const { rows } = await c.query<{ current_stage: string | null; has_appointment: boolean; debriefs: Record<string, unknown>[] }>(
          `SELECT j.current_stage,
                  EXISTS (SELECT 1 FROM jp_appointment a
                           WHERE a.crm_job_id = j.jp_job_id AND a.is_sales_type AND a.deleted_at IS NULL) AS has_appointment,
                  coalesce((SELECT json_agg(json_build_object(
                              'appointment_type', d.appointment_type, 'appointment_outcome', d.appointment_outcome,
                              'sale_amount', d.sale_amount, 'sale_close_type', d.sale_close_type,
                              'approval_status', d.approval_status, 'appointment_date', d.appointment_date::text))
                             FROM debrief d
                            WHERE (j.job_number IS NOT NULL AND lower(trim(d.crm_lead_id)) = lower(trim(j.job_number)))
                               OR d.crm_job_id = j.jp_job_id), '[]'::json) AS debriefs
             FROM jp_job j
            WHERE (j.jp_created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
              AND NOT j.is_insurance`,
          [from, to, BOARD_TIMEZONE]);
        return rows;
      }, "leads:flow", { quiet: true });
      return reply.send({ from, to, ...leadFunnel(rows) });
    },
  );
}
