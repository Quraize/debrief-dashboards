/**
 * The Overview funnel, followed lead by lead.
 *
 *   GET /api/leads/flow?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=activity|cohort
 *     -> leadFunnel(): leads, set / not set (+ reasons by stage), then per lead
 *        ran / no see / awaiting, demo / no demo / pending, sold / not sold.
 *
 * Leads are jobs created in the range (office calendar days), insurance and
 * warranty stages excluded. What happened next comes from the lead's debriefs,
 * matched on the job number the rep typed as the Lead ID (or the CRM job id
 * when the debrief has it).
 *
 * The row set is every lead that either ARRIVED in the range or has a sales
 * appointment DATED in it, each carrying both flags, so one query serves both
 * bases (see shared/src/leadFlow.js): activity counts the work done in the
 * range, cohort what became of the range's own leads.
 *
 * Only outcomes leave the server — no names — so it is open to every signed-in
 * role; it reads as the service role because the production role's RLS view of
 * these tables is not what a sales overview wants.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { withServiceRole } from "../db/client.js";
import { BOARD_TIMEZONE } from "../production/board.js";
import { leadFunnel } from "@allied/shared/leadFlow";

interface FlowQuery { from?: string; to?: string; basis?: string }
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface FlowRow {
  current_stage: string | null;
  created_in_range: boolean;
  has_appointment: boolean;
  appt_in_range: boolean;
  appointments_in_range: number;
  debriefs: Record<string, unknown>[];
}

export function registerLeadRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: FlowQuery }>(
    "/api/leads/flow",
    { preHandler: [requireAuth] },
    async (req: FastifyRequest<{ Querystring: FlowQuery }>, reply: FastifyReply) => {
      const { from, to } = req.query;
      if (!from || !to || !DAY.test(from) || !DAY.test(to)) return reply.code(400).send({ error: "from and to must be YYYY-MM-DD" });
      if (from > to) return reply.code(400).send({ error: "from must not be after to" });
      const basis = req.query.basis === "cohort" ? "cohort" : "activity";
      const data = await withServiceRole(async (c) => {
        const { rows } = await c.query<FlowRow>(
          `WITH appt AS (
             SELECT a.crm_job_id,
                    count(*) FILTER (WHERE a.appointment_date BETWEEN $1::date AND $2::date) AS in_range,
                    count(*) AS total
               FROM jp_appointment a
              WHERE a.is_sales_type AND a.deleted_at IS NULL AND a.crm_job_id IS NOT NULL
              GROUP BY a.crm_job_id)
           SELECT j.current_stage,
                  ((j.jp_created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date) AS created_in_range,
                  coalesce(appt.total, 0) > 0 AS has_appointment,
                  coalesce(appt.in_range, 0) > 0 AS appt_in_range,
                  coalesce(appt.in_range, 0)::int AS appointments_in_range,
                  coalesce((SELECT json_agg(json_build_object(
                              'appointment_type', d.appointment_type, 'appointment_outcome', d.appointment_outcome,
                              'sale_amount', d.sale_amount, 'sale_close_type', d.sale_close_type,
                              'approval_status', d.approval_status, 'appointment_date', d.appointment_date::text))
                             FROM debrief d
                            WHERE (j.job_number IS NOT NULL AND lower(trim(d.crm_lead_id)) = lower(trim(j.job_number)))
                               OR d.crm_job_id = j.jp_job_id), '[]'::json) AS debriefs
             FROM jp_job j
             LEFT JOIN appt ON appt.crm_job_id = j.jp_job_id
            WHERE NOT j.is_insurance
              AND ((j.jp_created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
                   OR coalesce(appt.in_range, 0) > 0)`,
          [from, to, BOARD_TIMEZONE]);
        return rows;
      }, "leads:flow", { quiet: true });
      // Every sales appointment dated in the range, resets included — the
      // number the Marketing dashboard counts, so the two can be reconciled.
      const appointments = data.reduce((n, r) => n + (r.appointments_in_range ?? 0), 0);
      return reply.send({ from, to, ...leadFunnel(data, { basis, from, to, appointments }) });
    },
  );
}
