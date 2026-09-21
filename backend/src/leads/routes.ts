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
import { requireAuth, requireRole } from "../middleware/auth.js";
import { withServiceRole } from "../db/client.js";
import { BOARD_TIMEZONE, jobProgressUrl } from "../production/board.js";
import { leadFunnel, visitBreakdown, isLeadStage, isDisqualifiedStage, leadReason, LEAD_REASONS } from "@allied/shared/leadFlow";
import { STAFF_ROLES } from "@allied/shared/constants";

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

/**
 * The sales and revenue the Sales dashboard reports for a range, by the same rule:
 * non-insurance debriefs whose EFFECTIVE sale date — the signed date, else the
 * appointment date — falls in the range, and which `isSale()` counts as a sale
 * (a positive amount, an actual close type, or a sale outcome). Kept in step
 * with shared/src/kpi.js: computeKPIs → filterByEffectiveSaleDate + isSale.
 */
const SALE_CLOSE_ACTUAL = ["First Call Close", "Rehash Close", "Follow-Up Close", "Reset Close", "Sale After Follow-Up"];
const SALE_OUTCOMES = ["Demo Completed — Sale", "Demo Completed — Sale / Credit Decline", "Demo Completed — Sale / Cancellation"];

/**
 * Every debrief for a visit in the range — the pool the Sales dashboard
 * counts (it filters the same table by appointment_date). Handed to the
 * funnel so its Ran and Demo cards are the dashboard's Ran and Demo. The
 * classifying is done by the shared rules, never re-expressed in SQL; only
 * the fields those rules read are selected, and no name leaves the server.
 */
async function visitsInRange(from: string, to: string): Promise<Record<string, unknown>[]> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<Record<string, unknown>>(
      `SELECT d.appointment_type, d.appointment_outcome, d.sales_appointment, d.approval_status,
              d.sale_amount, d.sale_close_type, d.business_division, d.product
         FROM debrief d
        WHERE d.appointment_date BETWEEN $1::date AND $2::date`,
      [from, to]);
    return rows;
  }, "leads:flow-visits", { quiet: true });
}

async function signedMonthSales(from: string, to: string): Promise<{ revenue: number; sales: number }> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ revenue: string; sales: string }>(
      `SELECT coalesce(sum(d.sale_amount), 0)::text AS revenue, count(*)::text AS sales
         FROM debrief d
        WHERE coalesce(d.sale_signed_date, d.appointment_date) BETWEEN $1::date AND $2::date
          AND coalesce(d.business_division, '') <> 'Insurance'
          AND coalesce(d.product, '') <> 'Insurance'
          AND (d.sale_amount > 0 OR d.sale_close_type = ANY($3) OR d.appointment_outcome = ANY($4))`,
      [from, to, SALE_CLOSE_ACTUAL, SALE_OUTCOMES]);
    return { revenue: Number(rows[0]?.revenue ?? 0), sales: Number(rows[0]?.sales ?? 0) };
  }, "leads:flow-revenue", { quiet: true });
}

/**
 * The rows behind one funnel card — what management clicks through to.
 *
 *   GET /api/leads/flow/detail?from&to&basis&card=disqualified
 *
 * Every card's list comes from the same classifier the count came from
 * (shared/src/leadFlow.js), so the page can never show 9 rows under a 10.
 * Unlike the counts this returns customer and rep NAMES, so it is closed to
 * the production role, whose accounts have no business on the sales side.
 */
const LEAD_CARDS: Record<string, string> = {
  leads: "Leads", valid: "Valid Leads", disqualified: "Disqualified", notSet: "Not Set",
};
const VISIT_CARDS: Record<string, string> = {
  set: "Appointment Set", ran: "Ran", noSee: "No See", awaiting: "Awaiting",
  demo: "Demo", noDemo: "No Demo", pending: "Result Pending", sold: "Sold", notSold: "No Sale",
};

interface LeadDetailRow {
  jp_job_id: string; jp_customer_id: string | null; job_number: string | null;
  customer_name: string | null; city: string | null; address: string | null;
  current_stage: string | null; created_day: string | null; has_appointment: boolean;
}
interface VisitDetailRow {
  id: string; customer_name: string | null; sales_rep: string | null; appointment_setter: string | null;
  appointment_date: string | null; sale_signed_date: string | null; appointment_type: string | null;
  appointment_outcome: string | null; sales_appointment: string | null; approval_status: string | null;
  sale_amount: string | null; sale_close_type: string | null; business_division: string | null; product: string | null;
  jp_job_id: string | null; jp_customer_id: string | null;
}

const place = (r: { city: string | null; address: string | null }) =>
  [r.city, r.address].map((s) => (s ?? "").trim()).filter(Boolean).join("/") || null;

async function leadDetail(from: string, to: string, card: string): Promise<unknown[]> {
  const rows = await withServiceRole(async (c) => {
    const { rows } = await c.query<LeadDetailRow>(
      `SELECT j.jp_job_id, j.jp_customer_id, j.job_number, cu.customer_name, cu.city, l.address,
              j.current_stage, (j.jp_created_at AT TIME ZONE $3)::date::text AS created_day,
              EXISTS (SELECT 1 FROM jp_appointment a
                       WHERE a.crm_job_id = j.jp_job_id AND a.is_sales_type AND a.deleted_at IS NULL) AS has_appointment
         FROM jp_job j
         LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
         LEFT JOIN jp_job_location l ON l.jp_job_id = j.jp_job_id
        WHERE NOT j.is_insurance
          AND (j.jp_created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`,
      [from, to, BOARD_TIMEZONE]);
    return rows;
  }, "leads:detail", { quiet: true });

  const all = rows.filter((r) => isLeadStage(r.current_stage));
  const reason = card.startsWith("reason:") ? card.slice(7) : null;
  const pick = all.filter((r) => {
    const dq = isDisqualifiedStage(r.current_stage);
    if (card === "leads") return true;
    if (card === "disqualified") return dq;
    if (card === "valid") return !dq;
    if (card === "notSet") return !dq && r.has_appointment !== true;
    if (reason) return !dq && r.has_appointment !== true && leadReason(r.current_stage) === reason;
    return false;
  });
  return pick.map((r) => ({
    kind: "lead", id: r.jp_job_id, customer: r.customer_name, place: place(r), jobNumber: r.job_number,
    stage: r.current_stage, date: r.created_day,
    reason: LEAD_REASONS.find((x) => x.key === leadReason(r.current_stage))?.label ?? null,
    jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
  }));
}

/** Bookings in the range with no debrief on that job and day — the Awaiting card. */
async function awaitingDetail(from: string, to: string): Promise<unknown[]> {
  const rows = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ jp_appointment_id: string; appointment_date: string; customer_name: string | null; city: string | null; address: string | null; job_number: string | null; jp_job_id: string | null; jp_customer_id: string | null }>(
      `SELECT a.jp_appointment_id, a.appointment_date::text AS appointment_date, cu.customer_name, cu.city, l.address,
              j.job_number, j.jp_job_id, j.jp_customer_id
         FROM jp_appointment a
         JOIN jp_job j ON j.jp_job_id = a.crm_job_id AND NOT j.is_insurance
         LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
         LEFT JOIN jp_job_location l ON l.jp_job_id = j.jp_job_id
        WHERE a.is_sales_type AND a.deleted_at IS NULL
          AND a.appointment_date BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM debrief d
                           WHERE d.appointment_date = a.appointment_date
                             AND ((j.job_number IS NOT NULL AND lower(trim(d.crm_lead_id)) = lower(trim(j.job_number)))
                                  OR d.crm_job_id = j.jp_job_id))
        ORDER BY a.appointment_date`,
      [from, to]);
    return rows;
  }, "leads:detail-awaiting", { quiet: true });
  return rows.map((r) => ({
    kind: "visit", id: r.jp_appointment_id, customer: r.customer_name, place: place(r), jobNumber: r.job_number,
    date: r.appointment_date, outcome: "No debrief filed yet", jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
  }));
}

async function visitDetail(from: string, to: string, card: string): Promise<unknown[]> {
  if (card === "awaiting") return awaitingDetail(from, to);
  // Sold is the signed-month population, the same one its money comes from.
  const signed = card === "sold";
  const rows = await withServiceRole(async (c) => {
    const { rows } = await c.query<VisitDetailRow>(
      `SELECT d.id, d.customer_name, d.sales_rep, d.appointment_setter, d.appointment_date::text AS appointment_date,
              d.sale_signed_date::text AS sale_signed_date, d.appointment_type, d.appointment_outcome, d.sales_appointment,
              d.approval_status, d.sale_amount::text AS sale_amount, d.sale_close_type, d.business_division, d.product,
              j.jp_job_id, j.jp_customer_id
         FROM debrief d
         LEFT JOIN jp_job j ON (j.job_number IS NOT NULL AND lower(trim(d.crm_lead_id)) = lower(trim(j.job_number)))
                            OR j.jp_job_id = d.crm_job_id
        WHERE ${signed ? "coalesce(d.sale_signed_date, d.appointment_date)" : "d.appointment_date"} BETWEEN $1::date AND $2::date
        ORDER BY d.appointment_date`,
      [from, to]);
    return rows;
  }, "leads:detail-visits", { quiet: true });

  const b = visitBreakdown(rows);
  const list = card === "set"
    ? [...b.ran, ...b.noSee]
    : (b as unknown as Record<string, VisitDetailRow[]>)[card] ?? [];
  return list.map((r) => ({
    kind: "visit", id: r.id, customer: r.customer_name, rep: r.sales_rep, setter: r.appointment_setter,
    date: r.appointment_date, signedDate: r.sale_signed_date, type: r.appointment_type, outcome: r.appointment_outcome,
    amount: r.sale_amount === null ? null : Number(r.sale_amount),
    jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
  }));
}

export function registerLeadRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: FlowQuery & { card?: string } }>(
    "/api/leads/flow/detail",
    { preHandler: [requireAuth, requireRole(...STAFF_ROLES)] },
    async (req: FastifyRequest<{ Querystring: FlowQuery & { card?: string } }>, reply: FastifyReply) => {
      const { from, to, card } = req.query;
      if (!from || !to || !DAY.test(from) || !DAY.test(to)) return reply.code(400).send({ error: "from and to must be YYYY-MM-DD" });
      if (from > to) return reply.code(400).send({ error: "from must not be after to" });
      if (!card) return reply.code(400).send({ error: "card is required" });
      const reason = card.startsWith("reason:") ? card.slice(7) : null;
      if (reason && !LEAD_REASONS.some((r) => r.key === reason)) return reply.code(400).send({ error: `unknown reason "${reason}"` });
      const isLead = !!reason || card in LEAD_CARDS;
      if (!isLead && !(card in VISIT_CARDS)) return reply.code(400).send({ error: `unknown card "${card}"` });
      const rows = isLead ? await leadDetail(from, to, card) : await visitDetail(from, to, card);
      const label = reason
        ? `Not Set — ${LEAD_REASONS.find((r) => r.key === reason)?.label ?? reason}`
        : (LEAD_CARDS[card] ?? VISIT_CARDS[card]!);
      return reply.send({ from, to, card, label, kind: isLead ? "lead" : "visit", count: rows.length, rows });
    },
  );

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
      const signed = await signedMonthSales(from, to);
      const visits = basis === "activity" ? await visitsInRange(from, to) : null;
      // Awaiting is counted the same way the Awaiting card's list is built, so
      // the number and the rows behind it can never disagree.
      const awaiting = basis === "activity" ? (await awaitingDetail(from, to)).length : null;
      return reply.send({ from, to, ...leadFunnel(data, {
        basis, from, to, appointments, visits, awaiting, signedRevenue: signed.revenue, signedSales: signed.sales,
      }) });
    },
  );
}
