// The production master sheet's WEEKLY JOB SHEET tab, column for column.
//
// Each row of that tab is one job that is in (or has been through) production.
// The office fills it by hand from JobProgress; this module is the contract
// for filling it from the JobProgress mirror instead: which sheet column holds
// which field, how each value is written, and a CSV whose columns line up with
// A..AB so a download can be pasted straight over the tab.
//
// Columns without a `key` are still filled by hand (checkboxes, lender notes,
// material vendor). A column marked `pending` would have a home in the sheet
// and in the row shape but no source in JobProgress yet; it exports blank
// rather than guessed. (None today: payment detail comes from the job's
// payment history — see paymentBreakdown.)

import { isPaidStage, isCompletedStage } from "./jobStages.js";

export const SHEET_COLUMNS = [
  // Column A stays the office's own key, "Town/Address/Customer"; the job
  // number lives in AC (managers' decision, 2026-09-09).
  { col: "A", header: "Town/Address/Customer", key: "label" },
  // B..D were hand-ticked; since 2026-09-21 JobProgress fills them (jobStatus).
  { col: "B", header: "PAID-IN-FULL", key: "pifStatus" },
  { col: "C", header: "PIF Date", key: "pifDate", type: "date" },
  { col: "D", header: "Job Complete", key: "jobComplete", type: "check" },
  { col: "E", header: "Job Folder" },
  { col: "F", header: "Site Assess" },
  { col: "G", header: "Job Costing Complete" },
  { col: "H", header: "Warranty Filed" },
  { col: "I", header: "BE Complete" },
  { col: "J", header: "Handoff Complete" },
  { col: "K", header: "Division", key: "division" },
  { col: "L", header: "Job Trade or Trades", key: "trades" },
  { col: "M", header: "Job Stage", key: "stage" },
  { col: "N", header: "Sales Rep", key: "salesRep" },
  { col: "O", header: "Sub", key: "sub" },
  { col: "P", header: "Scheduled Install Date", key: "scheduledInstallDate", type: "date" },
  { col: "Q", header: "Sale Date", key: "saleDate", type: "date" },
  { col: "R", header: "Gross $", key: "gross", type: "money" },
  { col: "S", header: "Change Orders", key: "changeOrders", type: "money" },
  { col: "T", header: "Total Rev w/ C.O.s", key: "totalRev", type: "money" },
  { col: "U", header: "Payment Method", key: "paymentMethod" },
  { col: "V", header: "Lender" },
  { col: "W", header: "Payment Method/Lender/Plan#/ Dealr Fee/ Loan Docs/ Tier if App/ Signed" },
  { col: "X", header: "Invoice Created & Payments Applied Upon Job Start" },
  { col: "Y", header: "Deposit", key: "deposit", type: "money" },
  { col: "Z", header: "Progress Payment Amounts", key: "progressPayments", type: "money" },
  { col: "AA", header: "Total Payments Received", key: "totalPayments", type: "money" },
  { col: "AB", header: "Balance Owed", key: "balanceOwed", type: "money" },
  { col: "AC", header: "Job #", key: "jobNumber" },
];

/** Extra columns after AC that tie a row back to JobProgress (the sheet keeps
 *  the same set far to the right, HT..HY). */
export const LINK_COLUMNS = [
  { header: "JP Customer ID", key: "customerId" },
  { header: "JP Job ID", key: "jobId" },
  { header: "JP Overview URL", key: "jpUrl" },
  { header: "JP Financials As Of", key: "financialsFetchedAt", type: "datetime" },
];

/** Columns the feed fills today. */
export const AUTOMATED_COLUMNS = SHEET_COLUMNS.filter((c) => c.key && !c.pending);
/** Columns with a slot in the feed that JobProgress cannot supply yet. */
export const PENDING_COLUMNS = SHEET_COLUMNS.filter((c) => c.pending);

/** Stage names the sheet treats as a cancellation: balance owed becomes 0. */
export const CANCELLATION_STAGE = /cancel/i;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Gross plus change orders, the sheet's column T (`=R+S`). Null until gross is known. */
export function totalRevenue(gross, changeOrders) {
  const g = num(gross);
  if (g === null) return null;
  return Math.round((g + (num(changeOrders) ?? 0)) * 100) / 100;
}

/**
 * The sheet's column AB: `IF(stage="Cancellation", 0, T - AA)`. Null when the
 * total is unknown; a missing payments figure counts as nothing received.
 */
export function balanceOwed(totalRev, totalPayments, stage) {
  if (CANCELLATION_STAGE.test(String(stage ?? ""))) return 0;
  const t = num(totalRev);
  if (t === null) return null;
  return Math.round((t - (num(totalPayments) ?? 0)) * 100) / 100;
}

/**
 * The sheet's payment columns from a job's payment history.
 *
 *   Y  Deposit                  the first payment recorded on the job
 *   Z  Progress Payment Amounts every later payment, summed
 *   U  Payment Method           the methods used, in order, joined with "/"
 *                               (the office writes "Check/Cash", "Credit Card")
 *
 * Canceled, voided or non-positive entries are ignored. Payments are ordered
 * by date, then by id for two on the same day. Y + Z equals what the sheet's
 * AA formula sums, and matches total_payment_received when JobProgress agrees
 * with itself.
 */
/** The payments that count: not cancelled or voided, a positive amount, oldest first. */
export function livePayments(payments) {
  return (payments ?? [])
    .filter((p) => !p.canceled && !/cancel|void/i.test(String(p.status ?? "")))
    .map((p) => ({ ...p, amount: num(p.amount) }))
    .filter((p) => p.amount !== null && p.amount > 0)
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? ""))
      || String(a.id ?? "").localeCompare(String(b.id ?? ""), undefined, { numeric: true }));
}

// ── Paid in full / job completed (columns B, C, D) ─────────────────────────
//
// Column B answers one question, PAID-IN-FULL: YES (green) or NO (red).
// Paid in full: the ledger shows nothing owed with money received, OR the
// job sits in one of the office's "Paid" stages (a third of the jobs on the
// sheet have no ledger figures at all, so the stage has to count). A job in
// a Paid stage whose ledger still shows a balance is YES with a warning
// (amber): either the payment was never entered in JobProgress or the totals
// were never fetched. Completed is column D's tick — the stage says so, see
// jobStages. A cancelled job gets neither.

export const PIF_STATUS = {
  yes: "YES",
  no: "NO",
  mismatch: "YES (ledger still shows a balance)",
};

/**
 * `{ paidInFull, completed, ledgerOwed, status, pifDate, tone }` for a job.
 * `status` is the text of column B (null = blank, cancelled); `pifDate` the
 * last payment's date once paid; `tone` colours the B cell:
 * paid (green) · unpaid (red) · mismatch (amber).
 */
export function jobStatus({ stage, balanceOwed, totalPayments, payments }) {
  const s = String(stage ?? "");
  if (CANCELLATION_STAGE.test(s)) return { paidInFull: false, completed: false, ledgerOwed: false, status: null, pifDate: null, tone: null };
  const owed = num(balanceOwed), received = num(totalPayments);
  const stagePaid = isPaidStage(s);
  const ledgerPaid = owed !== null && owed <= 0 && received !== null && received > 0;
  const ledgerOwed = owed !== null && owed > 0;
  const paidInFull = stagePaid || ledgerPaid;
  const completed = isCompletedStage(s);
  const mismatch = stagePaid && ledgerOwed;
  const live = livePayments(payments);
  const pifDate = paidInFull && live.length ? (live[live.length - 1].date ?? null) : null;
  if (!paidInFull) return { paidInFull, completed, ledgerOwed: false, status: PIF_STATUS.no, pifDate: null, tone: "unpaid" };
  return { paidInFull, completed, ledgerOwed: mismatch, status: mismatch ? PIF_STATUS.mismatch : PIF_STATUS.yes, pifDate, tone: mismatch ? "mismatch" : "paid" };
}

export function paymentBreakdown(payments) {
  const live = livePayments(payments);
  if (live.length === 0) return { deposit: null, progressPayments: null, paymentMethod: null, count: 0 };
  const deposit = live[0].amount;
  const progress = live.slice(1).reduce((n, p) => n + p.amount, 0);
  const methods = [...new Set(live.map((p) => p.methodLabel || p.method).filter(Boolean))];
  return {
    deposit,
    progressPayments: live.length > 1 ? Math.round(progress * 100) / 100 : null,
    paymentMethod: methods.length ? methods.join("/") : null,
    count: live.length,
  };
}

// ── Vendor bills ────────────────────────────────────────────────────────────
//
// JobProgress bills carry the vendor's QuickBooks display name; the sheet
// wants to know material from labor from carting. Classification is by
// keyword on the name — the office's vendors as of 2026-09-10 all resolve.

export const VENDOR_CATEGORIES = ["material", "labor", "carting", "other"];

const CARTING_RE = /\b(waste|disposal|dumpster|carting|container|bin drop|sanitation|recycling|hauling)\b/i;
const MATERIAL_RE = /\b(supply|supplies|lumber|building products|millworks?|depot|qxo|lansing|abc|beacon|srs|roofing supply|siding supply)\b/i;
const LABOR_RE = /\b(construction|contracting|contractors?|corp\.?|siding|roofing|gutters?|solar|enterprises?|services?|solutions?)\b/i;

/** material | labor | carting | other, from a vendor's display name. */
export function classifyVendor(name) {
  const n = String(name ?? "").trim();
  if (!n) return "other";
  if (CARTING_RE.test(n)) return "carting";
  if (MATERIAL_RE.test(n)) return "material";
  if (LABOR_RE.test(n)) return "labor";
  return "other";
}

/** The short names the tab's Material Vendor dropdown uses. */
export const VENDOR_SHORT_NAMES = [
  [/new castle/i, "NCBP"],
  [/^qxo\b/i, "QXO"],
  [/lansing/i, "Lansing"],
  [/\babc\b/i, "ABC"],
  [/home depot/i, "Home Depot"],
  [/garfield/i, "Garfield"],
  [/universal supply/i, "Universal"],
  [/allied supply/i, "Allied Supply"],
  [/athenia/i, "Athenia"],
];

export function vendorShortName(name) {
  const n = String(name ?? "").trim();
  for (const [re, short] of VENDOR_SHORT_NAMES) if (re.test(n)) return short;
  return n;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What a job's bills say for the sheet: the material vendors (column AD, the
 * tab's short names, "/"-joined in first-billed order), whether a carting
 * company billed the job (a container was on site — column AI), and the
 * actual-cost totals behind BH..BL. Bills are `{vendorName, category, amount, date}`.
 */
export function billBreakdown(bills) {
  const live = (bills ?? [])
    .map((b) => ({
      amount: num(b.amount) ?? 0, date: b.date, vendorName: b.vendorName,
      category: VENDOR_CATEGORIES.includes(b.category) ? b.category : classifyVendor(b.vendorName),
    }))
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  const totals = { material: null, labor: null, carting: null, other: null };
  const vendors = [];
  for (const b of live) {
    totals[b.category] = round2((totals[b.category] ?? 0) + b.amount);
    if (b.category === "material") {
      const short = vendorShortName(b.vendorName);
      if (short && !vendors.includes(short)) vendors.push(short);
    }
  }
  return {
    materialVendor: vendors.length ? vendors.join("/") : null,
    containerBilled: totals.carting !== null,
    actualMaterial: totals.material, actualLabor: totals.labor, actualCarting: totals.carting, actualOther: totals.other,
    count: live.length,
  };
}

/** `YYYY-MM-DD` → `M/D/YYYY`, the format the sheet's date columns use. */
export function sheetDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return "";
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

/** A cell value as the sheet would hold it: plain number for money, blank for unknown. */
export function sheetCell(column, row) {
  if (!column.key) return "";
  const v = row[column.key];
  if (v === null || v === undefined || v === "") return "";
  if (column.type === "date") return sheetDate(v);
  if (column.type === "datetime") return new Date(v).toISOString().replace("T", " ").slice(0, 16);
  if (column.type === "money") {
    const n = num(v);
    return n === null ? "" : n.toFixed(2);
  }
  return String(v);
}

/** Header row + one array per job, in sheet order (A..AB, then the link columns). */
export function sheetTable(rows) {
  const columns = [...SHEET_COLUMNS, ...LINK_COLUMNS];
  return [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => sheetCell(c, r)))];
}

const csvEscape = (v) => `"${String(v).replace(/"/g, '""')}"`;

/** CSV whose first 29 columns are the tab's A..AC, ready to paste over it. */
export function toSheetCsv(rows) {
  return sheetTable(rows).map((cells) => cells.map(csvEscape).join(",")).join("\r\n");
}

/** The hand-written key the tab uses in column A today: "Town/Address/Customer". */
export function rowLabel(row) {
  return [row.city, row.address, row.customer].map((s) => String(s ?? "").trim()).filter(Boolean).join("/");
}
