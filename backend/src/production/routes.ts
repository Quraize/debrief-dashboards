/**
 * Production API. Mounted under /api/production so the production front end —
 * today a tab in the debrief app, later possibly its own domain on this same
 * backend — has one prefix to call and nothing else to know about.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, requireCsrf, requireRole, clientIp } from "../middleware/auth.js";
import { PRODUCTION_ROLES } from "@allied/shared/constants";
import { boardForRange, validateRange, todayInBoardZone } from "./board.js";
import { refreshSchedules } from "./syncSchedules.js";

interface BoardQuery { date?: string; from?: string; to?: string }

export function registerProductionRoutes(app: FastifyInstance): void {
  const productionOnly = requireRole(...PRODUCTION_ROLES);

  app.get<{ Querystring: BoardQuery }>(
    "/api/production/board",
    { preHandler: [requireAuth, productionOnly] },
    async (req: FastifyRequest<{ Querystring: BoardQuery }>, reply: FastifyReply) => {
      const q = req.query ?? {};
      const date = q.date ?? (q.from ? undefined : todayInBoardZone());
      const range = validateRange(q.from ?? date, q.to ?? q.from ?? date);
      if ("error" in range) return reply.code(400).send({ error: range.error });
      const board = await boardForRange({ email: req.user!.email, role: req.user!.role }, range.from, range.to);
      return reply.send(board);
    },
  );

  app.post(
    "/api/production/sync",
    { preHandler: [requireAuth, requireCsrf, productionOnly] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!process.env.LEAP_API_TOKEN) {
        return reply.code(501).send({
          error: "Schedule sync is not enabled.",
          detail: "Needs LEAP_API_TOKEN in the backend environment.",
        });
      }
      console.info(`[production] manual schedule refresh by=${req.user!.email} ip=${clientIp(req)}`);
      const result = await refreshSchedules(req.user!.email);
      if (result.status === "failed") {
        return reply.code(502).send({
          error: "JobProgress did not return the schedule.",
          detail: result.errorMessage,
          syncRunId: result.syncRunId,
        });
      }
      return reply.send(result);
    },
  );
}
