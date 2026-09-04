/**
 * Backend "functions" — the endpoint the compatibility shim calls.
 *
 * `base44.functions.invoke(name, body)` maps to POST /api/functions/:name, and
 * the shim wraps the response as `{ data }` because ImportAppointments and
 * JobProgressSync both read `response.data`.
 *
 * This is a dispatch table rather than a generic runner: only these four names
 * exist, each is explicitly authorised, and an unknown name is a 404 rather
 * than anything more interesting.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, requireCsrf, requireRole, clientIp, userAgent } from "../middleware/auth.js";
import { runJobProgressSync, type SyncMode } from "../jobs/syncJobProgress.js";
import { JobProgressClient } from "../integrations/jobprogress/client.js";
import { runSyncExclusive, enqueueBackfill, syncStatus } from "../jobs/scheduler.js";
import { scanContractPrices, approveCandidate, rejectCandidate } from "../jobs/contractPrices.js";
import { runCustomerSync } from "../jobs/syncCustomers.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface FunctionParams { name: string }

/** Long-running work must not be bound by an HTTP timeout. */
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 10 * 60 * 1000);

export function registerFunctionRoutes(app: FastifyInstance): void {
  app.post<{ Params: FunctionParams; Body: Record<string, unknown> }>(
    "/api/functions/:name",
    {
      // Every function here is an administrative action against production data
      // or a third-party API. None is reachable by a rep.
      preHandler: [requireAuth, requireCsrf, requireRole("admin")],
    },
    async (req: FastifyRequest<{ Params: FunctionParams; Body: Record<string, unknown> }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      const actor = req.user!.email;
      const ctx = { ip: clientIp(req), userAgent: userAgent(req) };

      switch (req.params.name) {
        case "syncLeapJobProgress": {
          const mode = (body["mode"] as SyncMode) ?? "dry_run";
          if (mode !== "dry_run" && mode !== "commit") {
            return reply.code(400).send({ error: "mode must be dry_run or commit" });
          }
          console.info(`[functions] syncLeapJobProgress mode=${mode} by=${actor} ip=${ctx.ip}`);

          // A commit against a large window can outlast a browser's patience;
          // the request is bounded so the connection cannot hang indefinitely.
          // runSyncExclusive holds the same advisory lock as the scheduled and
          // backfill paths — a manual sync can never interleave with either.
          const result = await Promise.race([
            runSyncExclusive(() => runJobProgressSync({
              mode,
              dateFrom: body["date_from"] as string | undefined,
              dateTo: body["date_to"] as string | undefined,
              fullBackfill: Boolean(body["full_backfill"]),
              startedBy: actor,
            }), `manual:${actor}`),
            new Promise<never>((_, rejectAfter) =>
              setTimeout(() => rejectAfter(new Error(
                `Sync exceeded ${SYNC_TIMEOUT_MS / 1000}s. It continues server-side; check Sync Runs for the outcome.`,
              )), SYNC_TIMEOUT_MS).unref?.()),
          ]);
          return reply.send(result);
        }

        case "testLeapConnection": {
          // Deliberately shallow: proves the token authenticates, nothing more.
          try {
            const client = new JobProgressClient();
            await client.verifyConnection();
            return reply.send({ secretPresent: true, authenticationValid: true, blocker: null });
          } catch (err) {
            const message = (err as Error).message;
            return reply.send({
              secretPresent: Boolean(process.env.LEAP_API_TOKEN),
              authenticationValid: false,
              blocker: message,
            });
          }
        }

        case "backfillJobProgress": {
          // Queued, not run in-request: a year-long sweep outlasts any HTTP
          // timeout. Progress is visible as per-chunk Sync Runs rows.
          const mode = (body["mode"] as SyncMode) ?? "dry_run";
          if (mode !== "dry_run" && mode !== "commit") {
            return reply.code(400).send({ error: "mode must be dry_run or commit" });
          }
          const dateFrom = (body["date_from"] as string) ?? "2026-01-01";
          const dateTo = (body["date_to"] as string) ?? new Date().toISOString().slice(0, 10);
          if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) {
            return reply.code(400).send({ error: `Invalid window: ${dateFrom} → ${dateTo} (YYYY-MM-DD, from ≤ to)` });
          }
          console.info(`[functions] backfillJobProgress ${mode} ${dateFrom} → ${dateTo} by=${actor} ip=${ctx.ip}`);
          const queued = await enqueueBackfill({ mode, dateFrom, dateTo, startedBy: actor });
          return reply.code(202).send({ ...queued, mode, dateFrom, dateTo });
        }

        case "getSyncStatus":
          return reply.send(await syncStatus());

        case "syncCustomers": {
          if (!process.env.LEAP_API_TOKEN) {
            return reply.code(501).send({ error: "Customer sync is not enabled.", detail: "Needs LEAP_API_TOKEN." });
          }
          console.info(`[functions] syncCustomers by=${actor} ip=${ctx.ip}`);
          const result = await runCustomerSync({ startedBy: actor });
          if (result.status === "failed") {
            return reply.code(502).send({ error: "JobProgress did not return the customer list.", detail: result.errorMessage, syncRunId: result.syncRunId });
          }
          return reply.send(result);
        }

        case "scanContractPrices": {
          if (!process.env.ANTHROPIC_API_KEY) {
            return reply.code(501).send({
              error: "Contract scanning is not yet enabled.",
              detail: "Needs ANTHROPIC_API_KEY in the backend environment for the document-reading step.",
            });
          }
          if (!process.env.LEAP_API_TOKEN) {
            return reply.code(501).send({
              error: "Contract scanning is not yet enabled.",
              detail: "Needs LEAP_API_TOKEN to read job proposals.",
            });
          }
          const days = Number(body["days"] ?? 5);
          if (!Number.isInteger(days) || days < 1 || days > 60) {
            return reply.code(400).send({ error: "days must be an integer between 1 and 60" });
          }
          console.info(`[functions] scanContractPrices days=${days} by=${actor} ip=${ctx.ip}`);
          return reply.send(await scanContractPrices({ days, startedBy: actor }));
        }

        case "approveContractPrice": {
          const id = body["candidate_id"];
          if (typeof id !== "string" || !id) {
            return reply.code(400).send({ error: "candidate_id is required" });
          }
          console.info(`[functions] approveContractPrice ${id} by=${actor} ip=${ctx.ip}`);
          return reply.send(await approveCandidate(id, actor));
        }

        case "rejectContractPrice": {
          const id = body["candidate_id"];
          if (typeof id !== "string" || !id) {
            return reply.code(400).send({ error: "candidate_id is required" });
          }
          console.info(`[functions] rejectContractPrice ${id} by=${actor} ip=${ctx.ip}`);
          await rejectCandidate(id, actor, body["reason"] as string | undefined);
          return reply.send({ rejected: true });
        }

        // Both of these are built but cannot be verified without credentials,
        // so they report exactly what is missing rather than failing obscurely.
        case "importAppointments":
          return reply.code(501).send({
            error: "Spreadsheet import is not yet enabled.",
            detail: "Needs ANTHROPIC_API_KEY for the extraction step (Sprint 5, pending credentials).",
          });

        case "pushDebriefToSheet":
          return reply.code(501).send({
            error: "Google Sheets sync is not yet enabled.",
            detail: "Needs GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEETS_SPREADSHEET_ID, and the "
              + "spreadsheet shared with the service account (see docs/jobprogress-api.md §4.5 "
              + "for why a service account rather than OAuth).",
          });

        default:
          return reply.code(404).send({ error: `Unknown function: ${req.params.name}` });
      }
    },
  );
}
