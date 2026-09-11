/**
 * Manager approval of "No Demo — DQ / Do Not Reset" debriefs.
 *
 *   GET  /api/debriefs/approvals?status=pending|approved|rejected|all&page=&limit=
 *        The paginated table: every debrief with that outcome, newest first,
 *        with who approved or rejected it and when.
 *   POST /api/debriefs/:id/approval  { decision: "approve"|"reject", note? }
 *        Records the decision under the signed-in manager's name.
 *
 * Both are open to admin, sales_manager and project_manager. The write runs
 * as the service role after that role check: the debrief RLS policy lets the
 * author or a manager (admin/sales_manager) update a row, and a project
 * manager is neither — the approval columns are the one thing they may set.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, requireCsrf, requireRole, clientIp } from "../middleware/auth.js";
import { withServiceRole } from "../db/client.js";
import { APPROVAL_ROLES } from "@allied/shared/debriefApproval";
import { DQ_NO_DEMO_OUTCOME } from "@allied/shared/constants";

interface ListQuery { status?: string; page?: string; limit?: string }
interface DecisionBody { decision?: string; note?: string }

export interface ApprovalRow {
  id: string; appointment_date: string; customer_name: string; city: string | null; sales_rep: string; appointment_setter: string;
  appointment_type: string | null; dq_reason: string | null; notes: string | null; submitted_by: string; created_by: string | null;
  created_at: string; approval_status: string; approved_by: string | null; approved_by_name: string | null;
  approved_at: string | null; approval_note: string | null; crm_lead_id: string | null;
}

export function registerDebriefApprovalRoutes(app: FastifyInstance): void {
  const approvers = requireRole(...APPROVAL_ROLES);

  app.get<{ Querystring: ListQuery }>(
    "/api/debriefs/approvals",
    { preHandler: [requireAuth, approvers] },
    async (req: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
      const status = (req.query.status ?? "all").toLowerCase();
      if (!["all", "pending", "approved", "rejected"].includes(status)) return reply.code(400).send({ error: "status must be pending, approved, rejected or all" });
      const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
      const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
      const where = `appointment_outcome = $1${status === "all" ? "" : " AND coalesce(approval_status, 'pending') = $2"}`;
      const params: unknown[] = status === "all" ? [DQ_NO_DEMO_OUTCOME] : [DQ_NO_DEMO_OUTCOME, status];
      const data = await withServiceRole(async (c) => {
        const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM debrief WHERE ${where}`, params)).rows[0]!.n);
        const counts = (await c.query<{ s: string; n: string }>(
          `SELECT coalesce(approval_status, 'pending') AS s, count(*) AS n FROM debrief WHERE appointment_outcome = $1 GROUP BY 1`, [DQ_NO_DEMO_OUTCOME])).rows;
        const { rows } = await c.query<ApprovalRow>(
          `SELECT id, appointment_date::text, customer_name, city, sales_rep, appointment_setter, appointment_type, dq_reason, notes,
                  submitted_by, created_by, created_at, coalesce(approval_status, 'pending') AS approval_status,
                  approved_by, approved_by_name, approved_at, approval_note, crm_lead_id
             FROM debrief WHERE ${where}
            ORDER BY (coalesce(approval_status, 'pending') = 'pending') DESC, appointment_date DESC, created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, (page - 1) * limit]);
        return { total, counts, rows };
      }, "debriefs:approvals", { quiet: true });
      const byStatus = { pending: 0, approved: 0, rejected: 0 } as Record<string, number>;
      for (const c of data.counts) byStatus[c.s] = Number(c.n);
      return reply.send({ rows: data.rows, total: data.total, page, limit, pages: Math.max(1, Math.ceil(data.total / limit)), counts: byStatus, status });
    },
  );

  app.post<{ Params: { id: string }; Body: DecisionBody }>(
    "/api/debriefs/:id/approval",
    { preHandler: [requireAuth, requireCsrf, approvers] },
    async (req: FastifyRequest<{ Params: { id: string }; Body: DecisionBody }>, reply: FastifyReply) => {
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") return reply.code(400).send({ error: 'decision must be "approve" or "reject"' });
      const note = String(req.body?.note ?? "").trim().slice(0, 2000) || null;
      const me = req.user!;
      const row = await withServiceRole(async (c) => {
        const { rows } = await c.query<ApprovalRow>(
          `UPDATE debrief
              SET approval_status = $2, approved_by = $3, approved_by_name = $4, approved_at = now(), approval_note = $5
            WHERE id = $1 AND appointment_outcome = $6
            RETURNING id, appointment_date::text, customer_name, city, sales_rep, appointment_setter, appointment_type, dq_reason, notes,
                      submitted_by, created_by, created_at, approval_status, approved_by, approved_by_name, approved_at, approval_note, crm_lead_id`,
          [req.params.id, decision === "approve" ? "approved" : "rejected", me.email, me.fullName || me.email, note, DQ_NO_DEMO_OUTCOME]);
        return rows[0] ?? null;
      }, "debriefs:approve", { quiet: true });
      if (!row) return reply.code(404).send({ error: "No debrief with that id needs approval." });
      console.info(`[debriefs] ${decision} ${row.id} (${row.customer_name}, ${row.appointment_date}) by=${me.email} ip=${clientIp(req)}`);
      return reply.send({ data: row });
    },
  );
}
