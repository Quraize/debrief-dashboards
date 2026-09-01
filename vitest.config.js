import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./shared",
          environment: "node",
          include: ["tests/**/*.test.js"],
        },
      },
      {
        test: {
          name: "backend",
          root: "./backend",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          // Backend suites provision a real database and run every migration in
          // beforeAll, and argon2id is deliberately slow. The 10s default is
          // tuned for unit tests, not for that.
          hookTimeout: 60_000,
          testTimeout: 30_000,
          // Each file creates its own database, so files are independent - but
          // running them serially keeps migration advisory locks from
          // serialising anyway and makes failures easier to read.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "lcov"],
      include: ["shared/src/**/*.js", "backend/src/**/*.ts"],
      // shared/ holds the business rules; MIGRATION_PLAN.md §8.2 targets >=90% there.
      thresholds: {
        "shared/src/**/*.js": { statements: 55, branches: 70, functions: 55, lines: 55 },
      },
    },
  },
});
