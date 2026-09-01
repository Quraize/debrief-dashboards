import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * The @base44/vite-plugin used to supply two things we still need: the `@`
 * path alias, and a dev proxy that forwarded /api to the Base44 app. Removing
 * the plugin without replacing both would break every import in the project
 * and 404 every API call in development.
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    port: 5173,
    proxy: {
      // Production serves the app and the API from one origin behind Caddy
      // (MIGRATION_PLAN.md §10.1). This makes development match that, so
      // cookies, CSRF and same-origin fetches behave identically in both.
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: false, // keep the Host header: the session cookie is host-bound
      },
    },
  },

  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
