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
import { jobsBoard } from "./jobsBoard.js";
import { weeklyJobSheet, parseWeekFilter, filterSheetRows } from "./weeklyJobSheet.js";
import { buildWeeklySheetWorkbook } from "./weeklyJobSheetXlsx.js";
import { pushWeeklyJobSheet, sheetPushSettings, lastSheetPush, recentSheetPushes } from "./sheetPush.js";
import { runJobStageSync } from "./syncJobStages.js";

interface BoardQuery { date?: string; from?: string; to?: string }
interface WeekQuery { from?: string; to?: string; basis?: string }

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

  app.get(
    "/api/production/jobs",
    { preHandler: [requireAuth, productionOnly] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await jobsBoard({ email: req.user!.email, role: req.user!.role }));
    },
  );

  // The production master sheet's WEEKLY JOB SHEET tab, one row per tracked
  // job, in the tab's own column vocabulary (shared/src/weeklyJobSheet.js).
  app.get(
    "/api/production/weekly-job-sheet",
    { preHandler: [requireAuth, productionOnly] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await weeklyJobSheet({ email: req.user!.email, role: req.user!.role }));
    },
  );

  // The same rows as an Excel workbook in the tab's layout, optionally one
  // week's worth: ?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=install|sale|stage|any.
  app.get<{ Querystring: WeekQuery }>(
    "/api/production/weekly-job-sheet.xlsx",
    { preHandler: [requireAuth, productionOnly] },
    async (req: FastifyRequest<{ Querystring: WeekQuery }>, reply: FastifyReply) => {
      const filter = parseWeekFilter(req.query ?? {});
      if ("error" in filter) return reply.code(400).send({ error: filter.error });
      const sheet = await weeklyJobSheet({ email: req.user!.email, role: req.user!.role });
      const rows = filterSheetRows(sheet.rows, filter);
      const buffer = await buildWeeklySheetWorkbook(rows, {
        filter, generatedAt: sheet.generatedAt, syncedAt: sheet.sync?.finishedAt ?? sheet.sync?.startedAt ?? null, total: sheet.rows.length,
      });
      const span = filter.from || filter.to ? `-${filter.from ?? "start"}-to-${filter.to ?? "now"}` : "";
      console.info(`[production] weekly job sheet export by=${req.user!.email} rows=${rows.length}${span}`);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="weekly-job-sheet${span}.xlsx"`)
        .send(buffer);
    },
  );

  // The Google Sheet push: where it goes and how it last went…
  app.get(
    "/api/production/weekly-job-sheet/push",
    { preHandler: [requireAuth, productionOnly] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const s = sheetPushSettings();
      return reply.send({
        enabled: s.enabled, reason: s.reason, tab: s.tab, weeksBack: s.weeksBack, weeksAhead: s.weeksAhead, cron: s.cron,
        spreadsheetUrl: s.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit` : null,
        last: await lastSheetPush(),
        runs: await recentSheetPushes(30),
      });
    },
  );
  // …and the push itself. dry_run (default true) reads and plans but writes nothing.
  app.post<{ Body: { dry_run?: boolean } }>(
    "/api/production/weekly-job-sheet/push",
    { preHandler: [requireAuth, requireCsrf, productionOnly] },
    async (req: FastifyRequest<{ Body: { dry_run?: boolean } }>, reply: FastifyReply) => {
      const dryRun = req.body?.dry_run !== false;
      console.info(`[production] sheet push ${dryRun ? "dry run" : "COMMIT"} by=${req.user!.email} ip=${clientIp(req)}`);
      const result = await pushWeeklyJobSheet({ dryRun, startedBy: req.user!.email });
      if (result.status === "skipped") return reply.code(501).send({ error: "Google Sheet push is not configured.", detail: result.errorMessage, ...result });
      if (result.status === "failed") return reply.code(502).send({ error: "The Google Sheet push failed.", detail: result.errorMessage, ...result });
      return reply.send(result);
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
      console.info(`[production] manual refresh by=${req.user!.email} ip=${clientIp(req)}`);
      const result = await refreshSchedules(req.user!.email);
      if (result.status === "failed") {
        return reply.code(502).send({
          error: "JobProgress did not return the schedule.",
          detail: result.errorMessage,
          syncRunId: result.syncRunId,
        });
      }
      // The jobs board refreshes with the schedule: same button, same cadence.
      const stages = await runJobStageSync({ startedBy: req.user!.email });
      return reply.send({ ...result, stages: { status: stages.status, counts: stages.counts, errorMessage: stages.errorMessage } });
    },
  );
}
