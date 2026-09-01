/**
 * Seeds the dropdown lists (ListOption) from the canonical values in
 * @allied/shared/constants — sales reps, setters, outcomes, close types, and
 * the rest of what the debrief form's dropdowns read.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-list-options.ts
 *
 * Idempotent: a (category, value) pair that already exists is left untouched,
 * so this never duplicates and never overwrites values managed later through
 * Admin Settings.
 */
import pg from "pg";
import { SEED_OPTIONS } from "@allied/shared/constants";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  let inserted = 0, existing = 0;
  for (const [category, values] of Object.entries(SEED_OPTIONS as Record<string, string[]>)) {
    for (const value of values) {
      const res = await pool.query(
        `INSERT INTO list_option (category, value, created_by)
         SELECT $1, $2, 'seed'
          WHERE NOT EXISTS (
            SELECT 1 FROM list_option WHERE category = $1 AND value = $2)`,
        [category, value]);
      if (res.rowCount === 1) inserted++;
      else existing++;
    }
  }
  console.log(`list options: ${inserted} inserted, ${existing} already present`);
} finally {
  await pool.end();
}
