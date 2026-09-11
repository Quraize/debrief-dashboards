/**
 * Where the production maps get their background tiles.
 *
 *   GET /api/map-config -> { sources: [{ name, url, attribution, maxZoom, subdomains? }] }
 *
 * Served from the backend rather than compiled into the bundle for two
 * reasons: the key can be changed or rotated by editing the env file and
 * restarting, with no frontend rebuild; and nothing key-shaped ends up in a
 * VITE_ variable or a year-cached asset (MIGRATION_PLAN.md §5.4).
 *
 * A MapTiler key is not a secret in the way the JobProgress token is — it goes
 * to the browser, because the browser is what fetches the tiles — but it is
 * still an account credential, so it is handed out to signed-in staff only and
 * should be restricted to our domain in the MapTiler dashboard.
 *
 * The list is ordered: the frontend uses the first source that works and walks
 * down on failure. Without a key configured the keyless providers still give a
 * usable map, so nothing here is required for the page to function.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";

export interface TileSource {
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains?: string;
}

const OSM = '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The ordered provider list for the current environment. Exported for tests. */
export function tileSources(env: NodeJS.ProcessEnv = process.env): TileSource[] {
  const sources: TileSource[] = [];

  // Anything hand-configured wins outright.
  if (env["MAP_TILE_URL"]) {
    sources.push({
      name: "configured",
      url: env["MAP_TILE_URL"],
      attribution: env["MAP_TILE_ATTRIBUTION"] ?? `&copy; ${OSM}`,
      maxZoom: Number(env["MAP_TILE_MAX_ZOOM"] ?? 19) || 19,
    });
  }

  // MapTiler: an account with a free tier, and the one to keep working. The
  // style is configurable because "streets-v2" is a choice, not a constant.
  const key = (env["MAPTILER_KEY"] ?? "").trim();
  if (key) {
    const style = (env["MAPTILER_STYLE"] ?? "streets-v2").trim();
    sources.push({
      name: "maptiler",
      url: `https://api.maptiler.com/maps/${encodeURIComponent(style)}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`,
      attribution: `&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; ${OSM}`,
      maxZoom: 20,
    });
  }

  // Keyless fallbacks, so a missing or exhausted key never leaves a blank map.
  // Deliberately NOT tile.openstreetmap.org: that is the volunteer server, it
  // does not permit application use, and it blocked us in September 2026.
  sources.push({
    name: "esri",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ, USGS, Intermap",
    maxZoom: 19,
  });
  return sources;
}

export function registerMapConfigRoutes(app: FastifyInstance): void {
  app.get("/api/map-config", { preHandler: [requireAuth] }, async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.send({ sources: tileSources() }));
}
