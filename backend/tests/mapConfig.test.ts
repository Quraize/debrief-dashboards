/**
 * The tile-provider list behind the production maps: what each environment
 * gets, and that the key is never handed to an anonymous caller.
 */
import { describe, it, expect } from "vitest";
import { tileSources } from "../src/config/mapRoutes.js";

describe("tileSources", () => {
  it("falls back to a keyless provider when nothing is configured", () => {
    const sources = tileSources({});
    expect(sources).toHaveLength(1);
    expect(sources[0]!.name).toBe("esri");
    expect(sources[0]!.url).not.toContain("key=");
    // The volunteer server that blocked us must never come back as a default.
    expect(sources.some((s) => s.url.includes("tile.openstreetmap.org"))).toBe(false);
  });

  it("puts MapTiler first when a key is set, and keeps a fallback behind it", () => {
    const sources = tileSources({ MAPTILER_KEY: " abc123 ", MAPTILER_STYLE: "basic-v2" });
    expect(sources.map((s) => s.name)).toEqual(["maptiler", "esri"]);
    expect(sources[0]!.url).toBe("https://api.maptiler.com/maps/basic-v2/{z}/{x}/{y}.png?key=abc123");
    expect(sources[0]!.attribution).toMatch(/MapTiler/);
    expect(sources[0]!.attribution).toMatch(/OpenStreetMap/);
  });

  it("defaults the style, and lets an explicit URL override everything", () => {
    expect(tileSources({ MAPTILER_KEY: "k" })[0]!.url).toContain("/maps/streets-v2/");
    const sources = tileSources({ MAP_TILE_URL: "https://tiles.example.com/{z}/{x}/{y}.png", MAPTILER_KEY: "k" });
    expect(sources.map((s) => s.name)).toEqual(["configured", "maptiler", "esri"]);
    expect(sources[0]!.url).toBe("https://tiles.example.com/{z}/{x}/{y}.png");
  });

  it("ignores a blank key rather than building a keyless MapTiler URL", () => {
    expect(tileSources({ MAPTILER_KEY: "   " }).map((s) => s.name)).toEqual(["esri"]);
  });
});
