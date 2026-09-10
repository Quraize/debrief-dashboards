// The WEEKLY JOB SHEET tab of the production master sheet, every column, so an
// export reproduces the tab row for row: the synced columns filled from
// JobProgress, every other column present (with its checkbox, date, money or
// percent format and its dropdown list) for the team to fill by hand.
//
// Read off the office's copy on 2026-09-09. Column letters are the tab's own
// — HT..HZ really are that far right — so a block can be pasted over the tab.
// `key` names the feed field that fills the column; `formula` marks the
// tab's own formula columns; `list` is the tab's dropdown.

export const REP_LIST = ["Jason", "Pema", "Joe Mittiga", "Ashley", "Matt", "Michael"];
export const SUB_LIST = ["DNC/Manny", "Lucy Constr./Jay", "GroupMass", "AK/Darwin", "Cavallari", "Matt", "Gilmar", "Allied Other", "Pauly", "OTT Solar/Juan", "Unassaigned", "AMK/Henry"];
export const PAYMENT_METHOD_LIST = ["Check/Cash", "Finance", "Credit Card", "TBD"];
export const LENDER_LIST = ["Service", "Foundation", "N/A"];
export const VENDOR_LIST = ["NCBP", "QXO", "Lansing", "ABC"];
export const MANUFACTURER_LIST = ["Atlas", "GAF", "Hardie", "Certainteed"];

// Header fills, as the tab colours its column groups.
export const FILLS = { cyan: "FF00FFFF", magenta: "FFFF00FF", green: "FF00FF00", ledger: "FF2D7547", navy: "FF2E4877" };

const c = (col, header, over = {}) => ({ col, header, type: "text", width: 10, fill: "cyan", ...over });

export const MASTER_COLUMNS = [
  c("A", "Town/Address/Customer", { key: "label", width: 32.6 }),
  c("B", "PIF", { type: "check", fill: "magenta" }),
  c("C", "PIF Date", { type: "date", fill: "magenta", width: 8 }),
  c("D", "Job Complete", { type: "check", fill: "magenta" }),
  c("E", "Job Folder", { type: "check", fill: null }),
  c("F", "Site Assess", { type: "check" }),
  c("G", "Job Costing Complete", { type: "check" }),
  c("H", "Warranty Filed", { type: "check" }),
  c("I", "BE Complete", { type: "check", hidden: true }),
  c("J", "Handoff Complete", { type: "check", hidden: true }),
  c("K", "Division", { key: "division", width: 12.6 }),
  c("L", "Job Trade or Trades", { key: "trades", width: 10.8 }),
  c("M", "Job Stage", { key: "stage", width: 12.6 }),
  // N, O and U are synced, so they carry JobProgress's full names ("Jason
  // Malarchak", "Lucy Construction", "Cash/Check"), not the tab's short
  // dropdown entries. No dropdown on them: a list would reject every value.
  c("N", "Sales Rep", { key: "salesRep", width: 9.5 }),
  c("O", "Sub", { key: "sub", width: 12 }),
  c("P", "Scheduled Install Date", { key: "scheduledInstallDate", type: "date", width: 10.4 }),
  c("Q", "Sale Date", { key: "saleDate", type: "date", width: 10.4 }),
  c("R", "Gross $", { key: "gross", type: "money", fill: "green", width: 11.4 }),
  c("S", "Change Orders", { key: "changeOrders", type: "money", fill: "green", width: 8.9 }),
  c("T", "Total Rev w/ C.O.s", { key: "totalRev", type: "money", fill: "green", width: 11.4, formula: "R{r}+S{r}" }),
  c("U", "Payment Method", { key: "paymentMethod", fill: "green", width: 10.4 }),
  c("V", "Lender", { fill: "green", width: 10.9, hidden: true, list: LENDER_LIST }),
  c("W", "Payment Method/Lender/Plan#/ Dealr Fee/ Loan Docs/ Tier if App/ Signed", { fill: "green", width: 11.4, hidden: true }),
  c("X", "Invoice Created & Payments Applied Upon Job Start", { type: "check", fill: "green", width: 17.3, hidden: true }),
  c("Y", "Deposit", { key: "deposit", type: "money", fill: "green", width: 9.4 }),
  c("Z", "Progress Payment Amounts", { key: "progressPayments", type: "money", fill: "green", width: 13 }),
  c("AA", "Total Payments Received", { key: "totalPayments", type: "money", fill: "green", width: 9.8, formula: "SUM(Y{r}:Z{r})" }),
  c("AB", "Balance Owed", { key: "balanceOwed", type: "money", fill: "green", width: 12.4, formula: "T{r}-AA{r}" }),
  // The tab has "SQs" here; the managers moved the job number in (2026-09-09).
  c("AC", "Job #", { key: "jobNumber", width: 16 }),
  c("AD", "Material Vendor", { width: 12.1, list: VENDOR_LIST }),
  c("AE", "Manufacturer", { width: 12.5, list: MANUFACTURER_LIST }),
  c("AF", "Color", { width: 11.3 }),
  c("AG", "Material Delivery Scheduled", { type: "check", width: 10.3 }),
  c("AH", "Material Delivery Date", { type: "date", width: 11.5 }),
  c("AI", "Container Scheduled", { type: "check", width: 10.3 }),
  c("AJ", "Sub Scheduled", { type: "check", width: 11 }),
  c("AK", "Client Install Confirmed", { type: "check", width: 10.1 }),
  c("AL", "*Confirmed & Ready For Install*", { type: "check", width: 13.6 }),
  c("AM", "Container Pick Up Scheduled", { type: "check", width: 10.4 }),
  c("AN", "MTC Est", { width: 7.6 }),
  c("AO", "Date Started", { type: "date", width: 10.9 }),
  c("AP", "Date Completed", { type: "date", width: 13.8 }),
  c("AQ", "Final Walk Complete", { type: "check", width: 9.1 }),
  c("AR", "PIF Date", { type: "date", width: 7.8 }),
  c("AS", "MTC Actual", { width: 10.1 }),
  c("AT", "Final Work Order Ready", { type: "check", width: 7.6 }),
  c("AU", "Warranty Filed", { type: "check", width: 8.3, hidden: true }),
  c("AV", "Material Est", { type: "money", fill: "green", width: 10.4 }),
  c("AW", "Material %", { type: "pct", fill: "green", width: 9.3 }),
  c("AX", "Dealer Fee", { type: "money", fill: "green", width: 9.8 }),
  c("AY", "Labor Est", { type: "money", fill: "green", width: 9.4 }),
  c("AZ", "Labor %", { type: "pct", fill: "green", width: 8 }),
  c("BA", "GP %EST", { type: "pct", fill: "green", width: 8.6 }),
  c("BB", "GP% ACT", { type: "pct", fill: "green", width: 8.8 }),
  c("BC", "GP% DIFF", { type: "pct", fill: "green", width: 9 }),
  c("BD", "GP $EST", { type: "money", fill: "green", width: 9.4 }),
  c("BE", "GP $ACT", { type: "money", fill: "green", width: 8.3 }),
  c("BF", "Sales Commission Upd", { type: "check", fill: "green", width: 11 }),
  c("BG", "UPDATES / NOTES", { fill: "green", width: 60 }),
  c("BH", "Actual Material", { type: "money", fill: "ledger", width: 12.6 }),
  c("BI", "Actual Labor / Sub", { type: "money", fill: "ledger", width: 12.6 }),
  c("BJ", "Actual Carting", { type: "money", fill: "ledger", width: 12.6 }),
  c("BK", "Actual Dealer Fee", { type: "money", fill: "ledger", width: 12.6 }),
  c("BL", "Actual Other COGS", { type: "money", fill: "ledger", width: 12.6 }),
  c("BM", "Actual COGS (Ledger)", { type: "money", fill: "ledger", width: 14.5 }),
  c("BN", "Actual GP $ (Ledger)", { type: "money", fill: "ledger", width: 14.5 }),
  c("BO", "Actual GP % (Ledger)", { type: "pct", fill: "ledger", width: 14.5 }),
  c("BP", "Actual Material %", { type: "pct", fill: "ledger", width: 12 }),
  c("BQ", "Actual Labor %", { type: "pct", fill: "ledger", width: 12 }),
  c("BR", "Actual Carting %", { type: "pct", fill: "ledger", width: 12 }),
  c("BS", "Actual Dealer Fee %", { type: "pct", fill: "ledger", width: 12 }),
  c("HT", "JP Customer ID", { key: "customerId", fill: "navy", width: 12.6, hidden: true }),
  c("HU", "JP Job ID", { key: "jobId", fill: "navy", width: 12.6, hidden: true }),
  c("HV", "JP Overview URL", { key: "jpUrl", fill: "navy", width: 12.6, hidden: true }),
  c("HW", "JP Sync Stage", { key: "stage", fill: "navy", width: 12.6, hidden: true }),
  c("HX", "JP Last Sync", { key: "syncedAt", type: "datetime", fill: "navy", width: 12.6, hidden: true }),
  c("HY", "JP Sync Status", { key: "syncStatus", fill: "navy", width: 12.6, hidden: true }),
  c("HZ", "Sales Handoff Due", { type: "date", fill: "navy", width: 12.6, hidden: true }),
];

/** Columns the feed fills. */
export const MASTER_SYNCED = MASTER_COLUMNS.filter((col) => col.key);
/** Columns left for the team: everything with no feed field. */
export const MASTER_MANUAL = MASTER_COLUMNS.filter((col) => !col.key);
/** The tab's checkbox columns (Google Sheets checkboxes, TRUE/FALSE in Excel). */
export const MASTER_CHECKBOXES = MASTER_COLUMNS.filter((col) => col.type === "check");

export const NUM_FMT = { money: '"$"#,##0.00', pct: "0%", date: "m/d/yyyy", datetime: "m/d/yyyy h:mm" };

/** The Excel formula for a formula column on a given row, e.g. T on row 5 → "R5+S5". */
export const columnFormula = (column, rowNumber) => column.formula ? column.formula.replaceAll("{r}", String(rowNumber)) : null;

/** The label the tab puts above a week's block: "9/7/2026-9/13/2026". */
export function weekLabel(from, to) {
  const us = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ""); return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : ""; };
  if (!from && !to) return "";
  return `${us(from) || "…"}-${us(to) || "…"}`;
}
