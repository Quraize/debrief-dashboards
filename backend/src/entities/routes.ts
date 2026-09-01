/**
 * Generic entity REST routes.
 *
 * Shaped by the compatibility shim's contract, not by what a hand-designed API
 * would look like. That is a deliberate, temporary trade: it lets 31 frontend
 * files move from Base44 to our backend without being rewritten. Purpose-built
 * endpoints replace it once the shim is retired.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ENTITIES, isKnownEntity, type Role } from "./registry.js";
import * as repo from "./repository.js";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import type { SessionContext } from "../db/client.js";

interface EntityParams { entity: string; id?: string }
interface ListParams { limit?: string; offset?: string; sort?: string; [k: string]: unknown }

const ctxOf = (req: FastifyRequest): SessionContext => ({
  email: req.user!.email,
  role: req.user!.role,
});

/**
 * Resolves the entity and checks the caller's role for the operation.
 *
 * Returns 404 for an unknown entity and 403 for a known one the caller may not
 * touch. The distinction is safe here: the entity list is not a secret - it is
 * the same set the shim already knows about.
 */
function authorize(
  req: FastifyRequest<{ Params: EntityParams }>, reply: FastifyReply,
  op: "read" | "create" | "update" | "remove",
): boolean {
  const { entity } = req.params;
  if (!isKnownEntity(entity)) {
    reply.code(404).send({ error: `Unknown entity: ${entity}` });
    return false;
  }
  const allowed = ENTITIES[entity]![op];
  if (allowed === null) {
    reply.code(405).send({ error: `${op} is not available for ${entity}` });
    return false;
  }
  if (!allowed.includes(req.user!.role as Role)) {
    reply.code(403).send({ error: "Insufficient permissions" });
    return false;
  }
  return true;
}

export function registerEntityRoutes(app: FastifyInstance): void {
  // Everything below requires a session; writes additionally require CSRF.
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireAuth, requireCsrf] };

  app.get<{ Params: EntityParams; Querystring: ListParams }>(
    "/api/entities/:entity", read, async (req, reply) => {
      if (!authorize(req, reply, "read")) return;

      // Anything that is not a reserved paging key is an equality filter.
      // Unknown fields are rejected by the repository rather than ignored.
      const { limit, offset, sort, ...rest } = req.query;
      const filter: Record<string, string> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (typeof v === "string") filter[k] = v;
      }

      const result = await repo.list(ctxOf(req), req.params.entity, {
        sort,
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
        filter,
      });
      return reply.send(result);
    });

  app.get<{ Params: EntityParams }>("/api/entities/:entity/:id", read, async (req, reply) => {
    if (!authorize(req, reply, "read")) return;
    const row = await repo.getById(ctxOf(req), req.params.entity, req.params.id!);
    if (!row) return reply.code(404).send({ error: "Not found" });
    return reply.send({ data: row });
  });

  app.post<{ Params: EntityParams; Body: Record<string, unknown> }>(
    "/api/entities/:entity", write, async (req, reply) => {
      if (!authorize(req, reply, "create")) return;
      const row = await repo.create(ctxOf(req), req.params.entity, req.body ?? {});
      return reply.code(201).send({ data: row });
    });

  // PATCH, not PUT: the frontend sends partial objects, and treating those as a
  // full replacement would blank every field it happened not to include.
  app.patch<{ Params: EntityParams; Body: Record<string, unknown> }>(
    "/api/entities/:entity/:id", write, async (req, reply) => {
      if (!authorize(req, reply, "update")) return;
      const row = await repo.update(ctxOf(req), req.params.entity, req.params.id!, req.body ?? {});
      if (!row) return reply.code(404).send({ error: "Not found" });
      return reply.send({ data: row });
    });

  app.delete<{ Params: EntityParams }>("/api/entities/:entity/:id", write, async (req, reply) => {
    if (!authorize(req, reply, "remove")) return;
    const ok = await repo.remove(ctxOf(req), req.params.entity, req.params.id!);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return reply.send({ ok: true });
  });
}
