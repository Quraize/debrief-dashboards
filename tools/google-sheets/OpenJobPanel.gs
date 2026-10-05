/**
 * "Open job" panel for the PRODUCTION MASTER SHEET.
 *
 * Click any cell on a job's row; the panel on the right shows that job with an
 * "Open in JobProgress" button. Column A stays plain text, so clicking a name
 * never shows Google's link pop-up.
 *
 * The job's link comes from the hidden "JP Overview URL" column the automation
 * already fills (or is built from "JP Customer ID" + "JP Job ID"). Columns are
 * found by their row-1 heading, so moving them does not break the panel.
 *
 * Install (once, by someone with edit access):
 *   Extensions > Apps Script > paste this file > Save > reload the sheet.
 *   Then: menu "Allied" > "Open job panel". Approve the permissions the first time.
 */

const PANEL_TITLE = "Open job";
const H_URL = "jp overview url";
const H_CUSTOMER = "jp customer id";
const H_JOB = "jp job id";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Allied")
    .addItem("Open job panel", "showJobPanel")
    .addToUi();
}

function showJobPanel() {
  const html = HtmlService.createHtmlOutput(PANEL_HTML).setTitle(PANEL_TITLE);
  SpreadsheetApp.getUi().showSidebar(html);
}

/** The job on the row of the selected cell: { row, label, url } or a reason it has none. */
function getSelectedJob() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getActiveRange();
  if (!range) return { message: "Click a cell on a job's row." };
  const row = range.getRow();
  if (row < 2) return { message: "Click a cell on a job's row." };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map((h) => String(h).trim().toLowerCase());
  const urlCol = headers.indexOf(H_URL);
  const custCol = headers.indexOf(H_CUSTOMER);
  const jobCol = headers.indexOf(H_JOB);
  if (urlCol < 0 && (custCol < 0 || jobCol < 0)) {
    return { message: "This tab has no JobProgress columns." };
  }

  const values = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
  const label = String(values[0] || "").trim();
  let url = urlCol >= 0 ? String(values[urlCol] || "").trim() : "";
  if (!url && custCol >= 0 && jobCol >= 0 && values[custCol] && values[jobCol]) {
    url = "https://app.jobprogress.com/#/customer-jobs/" + values[custCol] + "/job/" + values[jobCol] + "/overview";
  }
  if (!/^https:\/\/app\.jobprogress\.com\//.test(url)) url = "";
  return { row: row, label: label, url: url, message: url ? "" : "No JobProgress job on this row." };
}

const PANEL_HTML = `
<!doctype html>
<html><head><base target="_blank">
<style>
  body { font: 14px/1.4 Arial, sans-serif; margin: 12px; color: #202124; }
  .row { color: #5f6368; font-size: 12px; }
  .name { font-weight: bold; margin: 4px 0 12px; word-break: break-word; }
  a.btn { display: block; text-align: center; background: #1a73e8; color: #fff; text-decoration: none;
          padding: 10px; border-radius: 6px; font-weight: bold; }
  a.btn:hover { background: #1557b0; }
  .msg { color: #5f6368; }
</style></head>
<body>
  <div id="out" class="msg">Click a cell on a job's row.</div>
<script>
  let last = "";
  function show(job) {
    const key = JSON.stringify(job);
    if (key !== last) {
      last = key;
      const out = document.getElementById("out");
      out.className = "";
      out.textContent = "";
      if (job.row) { const r = document.createElement("div"); r.className = "row"; r.textContent = "Row " + job.row; out.appendChild(r); }
      if (job.label) { const n = document.createElement("div"); n.className = "name"; n.textContent = job.label; out.appendChild(n); }
      if (job.url) {
        const a = document.createElement("a"); a.className = "btn"; a.href = job.url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = "Open in JobProgress"; out.appendChild(a);
      } else {
        const m = document.createElement("div"); m.className = "msg"; m.textContent = job.message || ""; out.appendChild(m);
      }
    }
    setTimeout(poll, 1000);
  }
  function poll() {
    google.script.run.withSuccessHandler(show).withFailureHandler(() => setTimeout(poll, 3000)).getSelectedJob();
  }
  poll();
</script>
</body></html>`;
