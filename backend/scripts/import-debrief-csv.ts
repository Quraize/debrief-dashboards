/**
 * Imports the app's own Export Center CSV (the "Debrief Responses" display
 * export) into the debrief table.
 *
 *   DATABASE_URL=... npx tsx scripts/import-debrief-csv.ts <file.csv> [--dry-run] [--infer-types]
 *
 * This exists for one situation: the real Base44 entity export
 * (scripts/export-from-base44.sh → import-base44-export.ts) is unavailable,
 * and the display CSV is the only surviving copy of the debrief history. Use
 * the entity export when you can — the CSV is a REPORT, and it is missing two
 * fields the KPI engine keys off:
 *
 *   * appointment_type  — without it, Appointment Opportunities, Two-Leg %,
 *     and Demo Rate treat the row as ineligible. `--infer-types` approximates
 *     it (Rehash Close → Rehash, Reset Close → Reset Demo, otherwise First
 *     Appointment) and stamps data_quality_flag so inferred rows stay
 *     identifiable. The inference is explicitly a business approximation.
 *   * sale_signed_date  — signed-month revenue attribution falls back to the
 *     appointment month for these rows. Nothing to infer it from.
 *
 * Row identity is a hash of the row's stable fields, so re-running the import
 * inserts nothing the second time, and every imported row carries
 * created_by = 'csv-import' so the whole batch can be found — or deleted, if
 * the authoritative export ever turns up:
 *
 *   DELETE FROM debrief WHERE created_by = 'csv-import';
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

// ── CSV parsing (RFC 4180: quoted fields may hold commas, quotes, newlines) ──

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ── Display header -> debrief column (the inverse of kpi.js buildExportRows) ──
// Headers not listed are derived values with no column (Primary Revenue Credit)
// or duplicates (Primary Sales Rep repeats Sales Rep).

const HEADER_TO_COLUMN: Record<string, string> = {
  "Lead ID / JobProgress ID": "crm_lead_id",
  "Customer Name": "customer_name",
  "Phone Number": "phone",
  "Street Address": "address",
  "City": "city",
  "Appointment Date": "appointment_date",
  "Sales Rep": "sales_rep",
  "Appointment Setter": "appointment_setter",
  "Marketing Source": "marketing_source",
  "Referral Source": "referral_source",
  "Division": "product",
  "Appointment Outcome": "appointment_outcome",
  "Decision Maker Status": "decision_maker_status",
  "First Price Given": "first_price_given",
  "Additional Prices Given": "additional_prices_given",
  "Prices Given": "prices_given",
  "Financing Offered": "financing_offered",
  "Financing Result": "financing_result",
  "Main Objection": "main_objection",
  "Pre-Close Answer": "pre_close_answer",
  "Closing Question Answer": "closing_question_answer",
  "Rep Response": "rep_response",
  "Reset Needed": "reset_needed",
  "Reset Date": "reset_date",
  "Follow-Up Needed": "follow_up_needed",
  "Follow-Up Date": "follow_up_date",
  "Sale Amount": "sale_amount",
  "Secondary Sales Rep": "secondary_sales_rep",
  "Primary Split %": "primary_rep_split_pct",
  "Secondary Split %": "secondary_rep_split_pct",
  "Sale / Close Type": "sale_close_type",
  "Credit Decline?": "credit_decline",
  "Cancellation?": "cancellation",
  "Cancellation Reason": "cancellation_reason",
  "Submitted By": "submitted_by",
  "Submitted Date/Time": "created_at",
  "Notes": "notes",
  "Data Quality Flag": "data_quality_flag",
  "Products Presented Other": "products_presented_other",
  "Financing Not Offered Reason": "financing_not_offered_reason",
  "Financing Option Presented": "financing_option_presented",
  "Objection Customer Wording": "objection_customer_wording",
  "Step 7 Result": "step7_result",
  "Walk of Life Issues": "walk_of_life_issues",
  "Step 7 Coaching Notes": "step7_coaching_notes",
  "Step 7 Coaching Followup": "step7_coaching_followup",
  "Step 7 Things to Review": "step7_things_to_review",
  "Reset Appointment Scheduled": "reset_appointment_scheduled",
  "Reset Follow-Up Notes": "reset_follow_up_notes",
  "Business Division": "business_division",
  "Trade": "trade",
  "Contingency Signed": "contingency_signed",
  "Contingency Signed Date": "contingency_signed_date",
  "Demo Completed": "demo_completed",
  "Insurance Outcome": "insurance_outcome",
  "Upgrade Price 1": "upgrade_price_1",
  "Upgrade Price 2": "upgrade_price_2",
  "Upgrade Price 3": "upgrade_price_3",
  "Other Prices Given": "other_prices_given",
  "Other Prices Details": "other_prices_details",
  "Other Prices Amount": "other_prices_amount",
  "Total Job Price Provided": "total_job_price_provided",
  "Total Job Price": "total_job_price",
  "Upgrade Sold Accepted": "upgrade_sold_accepted",
  "Accepted Upgrade Amount": "accepted_upgrade_amount",
  "Final Contract Signed": "final_contract_signed",
  "Final Contract Date": "final_contract_date",
};

const isBlank = (v: string) => v.trim() === "";

/** Coerces a display value for a PostgreSQL column type; undefined = omit. */
function coerce(value: string, type: string): unknown {
  const v = value.trim();
  if (isBlank(v)) return null;
  switch (type) {
    case "boolean":
      // The export wrote booleans as Yes/No; blank already returned null above.
      if (/^yes$/i.test(v)) return true;
      if (/^no$/i.test(v)) return false;
      return null;
    case "numeric":
    case "integer": {
      const n = Number(v.replace(/[$,]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }
    case "date": {
      const d = v.slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
    }
    case "timestamp with time zone": {
      const t = new Date(v);
      return isNaN(t.getTime()) ? undefined : t.toISOString();
    }
    default:
      return v;
  }
}

/** The approximation --infer-types applies. Kept small and inspectable. */
function inferAppointmentType(closeType: string | null): string {
  if (closeType === "Rehash Close") return "Rehash";
  if (closeType === "Reset Close") return "Reset Demo";
  return "First Appointment";
}

// ── Main ──

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const inferTypes = args.includes("--infer-types");
if (!file) {
  console.error("usage: import-debrief-csv.ts <file.csv> [--dry-run] [--infer-types]");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const rows = parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""));
const header = rows.shift();
if (!header) throw new Error("empty file");

const unknownHeaders = header.filter(
  (h) => !(h in HEADER_TO_COLUMN) && !["Primary Sales Rep", "Primary Revenue Credit", "Secondary Revenue Credit"].includes(h));
if (unknownHeaders.length > 0) {
  console.warn(`ignoring ${unknownHeaders.length} unknown column(s): ${unknownHeaders.join(", ")}`);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const { rows: meta } = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'debrief'`);
  const columnTypes = new Map(meta.map((m) => [m.column_name, m.data_type]));

  let inserted = 0, skipped = 0, rejected = 0, inferred = 0;
  const reasons = new Map<string, number>();
  const reject = (why: string) => {
    rejected++;
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  };

  for (const raw of rows) {
    if (raw.length === 1 && isBlank(raw[0]!)) continue;

    const record: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const column = HEADER_TO_COLUMN[h];
      if (!column) return;
      const type = columnTypes.get(column);
      if (!type) return;
      const value = coerce(raw[i] ?? "", type);
      if (value !== undefined && value !== null) record[column] = value;
    });

    if (!record["appointment_date"] && !record["crm_lead_id"] && !record["customer_name"]) {
      reject("no identifying fields (date, lead id, name all blank)");
      continue;
    }

    if (inferTypes && !record["appointment_type"]) {
      record["appointment_type"] = inferAppointmentType((record["sale_close_type"] as string) ?? null);
      record["data_quality_flag"] = [record["data_quality_flag"], "appointment_type inferred from close type"]
        .filter(Boolean).join("; ");
      inferred++;
    }

    // Deterministic identity: the same CSV row always produces the same id,
    // which is what makes a re-run insert nothing.
    record["id"] = "csv-" + createHash("sha256")
      .update([record["crm_lead_id"], record["appointment_date"], record["created_at"],
               record["customer_name"], record["appointment_outcome"]].map((v) => v ?? "").join("|"))
      .digest("hex").slice(0, 32);
    record["created_by"] = "csv-import";

    if (dryRun) { inserted++; continue; }

    const columns = Object.keys(record);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    try {
      const res = await pool.query(
        `INSERT INTO debrief (${columns.map((c) => `"${c}"`).join(", ")})
         VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING`,
        columns.map((c) => record[c]));
      if (res.rowCount === 1) inserted++;
      else skipped++;
    } catch (err) {
      reject((err as Error).message.slice(0, 120));
    }
  }

  console.log(`${dryRun ? "[dry run] would insert" : "inserted"}: ${inserted}`);
  console.log(`skipped (already imported): ${skipped}`);
  console.log(`rejected: ${rejected}`);
  for (const [why, count] of reasons) console.log(`  ${count}× ${why}`);
  if (inferTypes) {
    console.log(`appointment_type inferred on ${inferred} row(s) — flagged in data_quality_flag`);
  } else {
    console.log("note: appointment_type left blank (CSV lacks it) — Appointments/Two-Leg/Demo Rate");
    console.log("      will not count these rows. Re-run with --infer-types to approximate it.");
  }
  console.log("note: sale_signed_date is not in this export — revenue for these rows attributes");
  console.log("      to the appointment month.");
} finally {
  await pool.end();
}
