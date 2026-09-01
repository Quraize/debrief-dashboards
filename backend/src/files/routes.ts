/**
 * File upload and retrieval.
 *
 * Replaces Base44's `integrations.Core.UploadFile`. The only current caller is
 * Import Appointments, which uploads a spreadsheet and hands the returned URL to
 * the import job.
 *
 * These files are lists of customer appointments — names, phone numbers,
 * addresses — so the security posture matters more than the feature:
 *
 *   * the client's filename NEVER touches a path. It is stored for display
 *     only. Building a path from it is how `../../etc/passwd` gets written;
 *   * the storage key is a random id, so nothing is guessable;
 *   * retrieval goes through an authenticated route, never a static directory;
 *   * size and content type are bounded before anything reaches disk.
 */
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withUser, dbApp } from "../db/client.js";
import { requireAuth, requireCsrf, requireRole } from "../middleware/auth.js";

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? "./uploads");
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024); // 25 MiB

/**
 * Spreadsheets only. Browsers are inconsistent about the type they send for
 * CSV, so the extension is checked as well — both must look plausible.
 */
const ALLOWED_TYPES = new Set([
  "text/csv", "application/csv", "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream", // what several browsers send for .csv
]);
const ALLOWED_EXTENSIONS = [".csv", ".xls", ".xlsx"];

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

/**
 * Control characters, including NUL.
 *
 * Built with `new RegExp` from an escaped string rather than a regex literal:
 * a literal would have to contain actual control characters, which are
 * invisible in review and get silently mangled by anything that rewrites this
 * file. The escapes make the intent explicit and the source safe to edit.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
const PATH_SEPARATORS = /[\\/]/g;

/**
 * Cleans a client-supplied filename before it is stored as display metadata.
 *
 * It is never used to build a path — but it IS written to the database, and an
 * unsanitised filename reaches PostgreSQL as-is. A NUL byte there is rejected
 * outright ("invalid byte sequence for encoding UTF8: 0x00"), turning a hostile
 * upload into a 500. NUL bytes in filenames are also a long-standing path
 * truncation trick, so stripping them is worth doing on its own merits.
 *
 * Separators are replaced as defence in depth: nothing builds a path from this
 * value today, and nothing should be able to start doing so by accident.
 */
export function sanitiseFilename(raw: string): string {
  const cleaned = raw.replace(CONTROL_CHARS, "").replace(PATH_SEPARATORS, "_").trim();
  // Long enough for any real filename, short enough not to bloat a row.
  const capped = cleaned.slice(0, 255);
  return capped.length > 0 ? capped : "upload";
}

export function registerFileRoutes(app: FastifyInstance): void {
  app.post("/api/files/upload", {
    // Importing appointments is a manager activity; so is uploading the file
    // for it. Mirrors the RLS policy on uploaded_file.
    preHandler: [requireAuth, requireCsrf, requireRole("admin", "sales_manager")],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const part = await req.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
    if (!part) return reply.code(400).send({ error: "No file supplied" });

    const originalName = sanitiseFilename(part.filename ?? "upload");
    const extension = extensionOf(originalName);
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      return reply.code(415).send({
        error: `Unsupported file type "${extension || "unknown"}". Upload a .csv, .xls or .xlsx file.`,
      });
    }
    if (!ALLOWED_TYPES.has(part.mimetype)) {
      return reply.code(415).send({ error: `Unsupported content type: ${part.mimetype}` });
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    // The storage key is generated, never derived from the upload. The
    // extension comes from our own allowlist rather than the filename, so even
    // that cannot smuggle anything through.
    const id = randomUUID();
    const storageKey = `${id}${extension}`;
    const destination = join(UPLOAD_DIR, storageKey);

    // Defence in depth: a generated uuid cannot escape UPLOAD_DIR, but assert it
    // anyway so a future change to the naming cannot quietly introduce traversal.
    if (!resolve(destination).startsWith(UPLOAD_DIR + sep)) {
      return reply.code(400).send({ error: "Invalid storage path" });
    }

    const hash = createHash("sha256");
    part.file.on("data", (chunk: Buffer) => hash.update(chunk));

    try {
      await pipeline(part.file, createWriteStream(destination));
    } catch (err) {
      await unlink(destination).catch(() => {});
      throw err;
    }

    // fastify-multipart truncates rather than throwing when the limit is hit,
    // so the flag has to be checked explicitly — otherwise a too-large upload is
    // silently stored as a partial file and imported as though it were complete.
    if (part.file.truncated) {
      await unlink(destination).catch(() => {});
      return reply.code(413).send({
        error: `File exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit.`,
      });
    }

    const { size } = await stat(destination);
    if (size === 0) {
      await unlink(destination).catch(() => {});
      return reply.code(400).send({ error: "File is empty" });
    }

    const ctx = { email: req.user!.email, role: req.user!.role };
    const row = await withUser(dbApp(), ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO uploaded_file
           (id, storage_key, original_name, content_type, size_bytes, checksum, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, storageKey, originalName, part.mimetype, size, hash.digest("hex"), req.user!.email],
      );
      return rows[0]!;
    });

    // The shape Base44's UploadFile returned, so the shim needs no translation.
    return reply.code(201).send({
      file_url: `/api/files/${row.id}`,
      file_id: row.id,
      original_name: originalName,
      size_bytes: size,
    });
  });

  app.get<{ Params: { id: string } }>("/api/files/:id", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const ctx = { email: req.user!.email, role: req.user!.role };
    const file = await withUser(dbApp(), ctx, async (c) => {
      const { rows } = await c.query<{
        storage_key: string; original_name: string; content_type: string;
      }>(
        `SELECT storage_key, original_name, content_type FROM uploaded_file WHERE id = $1`,
        [req.params.id],
      );
      return rows[0] ?? null;
    });

    // Absent or invisible-under-RLS are both 404: distinguishing them would
    // confirm the file exists to someone not allowed to know.
    if (!file) return reply.code(404).send({ error: "Not found" });

    const path = join(UPLOAD_DIR, file.storage_key);
    if (!resolve(path).startsWith(UPLOAD_DIR + sep)) {
      return reply.code(404).send({ error: "Not found" });
    }

    return reply
      .header("Content-Type", file.content_type)
      // `attachment` so a spreadsheet can never render in the browser context.
      .header("Content-Disposition",
        `attachment; filename="${file.original_name.replace(/["\r\n]/g, "")}"`)
      .send(createReadStream(path));
  });
}
