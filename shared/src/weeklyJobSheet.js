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

export const SHEET_COLUMNS = [
  { col: "A", header: "Job #", key: "jobNumber" },
  { col: "B", header: "PIF" },
  { col: "C", header: "PIF Date" },
  { col: "D", header: "Job Complete" },
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
];

/** Extra columns after AB that tie a row back to JobProgress (the sheet keeps
 *  the same set far to the right, HT..HY). */
export const LINK_COLUMNS = [
  { header: "Town/Address/Customer", key: "label" },
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
export function paymentBreakdown(payments) {
  const live = (payments ?? [])
    .filter((p) => !p.canceled && !/cancel|void/i.test(String(p.status ?? "")))
    .map((p) => ({ ...p, amount: num(p.amount) }))
    .filter((p) => p.amount !== null && p.amount > 0)
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? ""))
      || String(a.id ?? "").localeCompare(String(b.id ?? ""), undefined, { numeric: true }));
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

/** CSV whose first 28 columns are the tab's A..AB, ready to paste over it. */
export function toSheetCsv(rows) {
  return sheetTable(rows).map((cells) => cells.map(csvEscape).join(",")).join("\r\n");
}

/** The hand-written key the tab uses in column A today: "Town/Address/Customer". */
export function rowLabel(row) {
  return [row.city, row.address, row.customer].map((s) => String(s ?? "").trim()).filter(Boolean).join("/");
}
