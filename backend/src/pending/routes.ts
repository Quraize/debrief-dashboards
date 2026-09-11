/**
 * Pending-work counts for the sidebar badges.
 *
 *   GET /api/pending-counts -> { counts: { priceReview, debriefApprovals } }
 *
 * One cheap query per queue the caller is allowed to see, so the menu can carry
 * a number next to the pages that are waiting on somebody. A queue the caller
 * has no access to is simply absent from the map rather than reported as zero —
 * the badge must never tell a rep how much work a manager is sitting on.
 *
 * Counting runs as the service role because the two source tables are read
 * through different gates (price candidates are admin-only by RLS, the approval
 * columns live on `debrief`), and the role check above has already decided who
 * may see which number.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { withServiceRole } from "../db/client.js";
import { APPROVAL_ROLES } from "@allied/shared/debriefApproval";
import { DQ_NO_DEMO_OUTCOME } from "@allied/shared/constants";

export function registerPendingCountRoutes(app: FastifyInstance): void {
  app.get("/api/pending-counts", { preHandler: [requireAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const role = req.user!.role;
    const wantsPrices = role === "admin";
    const wantsApprovals = (APPROVAL_ROLES as string[]).includes(role);
    if (!wantsPrices && !wantsApprovals) return reply.send({ counts: {} });

    const counts = await withServiceRole(async (c) => {
      const out: Record<string, number> = {};
      if (wantsPrices) {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM jp_price_candidate WHERE status = 'pending'`);
        out["priceReview"] = Number(rows[0]!.n);
      }
      if (wantsApprovals) {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM debrief
            WHERE appointment_outcome = $1 AND coalesce(approval_status, 'pending') = 'pending'`,
          [DQ_NO_DEMO_OUTCOME]);
        out["debriefApprovals"] = Number(rows[0]!.n);
      }
      return out;
    }, "pending:counts", { quiet: true });

    return reply.send({ counts });
  });
}
