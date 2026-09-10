import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { PRODUCTION_ROLES } from "@allied/shared/constants";
import { STAGE_GROUPS } from "@allied/shared/jobStages";
import { SHEET_COLUMNS, PENDING_COLUMNS, toSheetCsv, sheetDate } from "@allied/shared/weeklyJobSheet";
import { Download, RefreshCw, Loader2, ExternalLink, Search, Info } from "lucide-react";
import { productionApi } from "./api";
import { qs } from "@/api/http";

function relative(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : new Date(iso).toLocaleString();
}
const money = (v) => (v == null ? "" : "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] == null ? 0 : Number(r[key])), 0);

// The on-screen table shows the sheet's automated columns plus what the
// office needs to recognise a row (customer, town). The CSV is the full A..AB.
const VISIBLE = [
  { key: "label", label: "Town/Address/Customer", col: "A" },
  { key: "jobNumber", label: "Job #", col: "AC" },
  { key: "division", label: "Division", col: "K" },
  { key: "trades", label: "Trades", col: "L" },
  { key: "stage", label: "Job Stage", col: "M" },
  { key: "salesRep", label: "Sales Rep", col: "N" },
  { key: "sub", label: "Sub", col: "O" },
  { key: "scheduledInstallDate", label: "Sched. Install", col: "P", type: "date" },
  { key: "saleDate", label: "Sale Date", col: "Q", type: "date" },
  { key: "gross", label: "Gross $", col: "R", type: "money" },
  { key: "changeOrders", label: "C.O.s", col: "S", type: "money" },
  { key: "totalRev", label: "Total Rev", col: "T", type: "money" },
  { key: "paymentMethod", label: "Payment Method", col: "U" },
  { key: "deposit", label: "Deposit", col: "Y", type: "money" },
  { key: "progressPayments", label: "Progress Pmts", col: "Z", type: "money" },
  { key: "totalPayments", label: "Payments", col: "AA", type: "money" },
  { key: "balanceOwed", label: "Balance", col: "AB", type: "money" },
  { key: "materialVendor", label: "Material Vendor", col: "AD" },
  { key: "actualMaterial", label: "Actual Material", col: "BH", type: "money" },
  { key: "actualLabor", label: "Actual Labor/Sub", col: "BI", type: "money" },
  { key: "actualCarting", label: "Actual Carting", col: "BJ", type: "money" },
];

export default function WeeklyJobSheet() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const allowed = !!me && PRODUCTION_ROLES.includes(me.role);

  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [onlyGaps, setOnlyGaps] = useState(false);
  // The sheet's weekly blocks: a job belongs to a week by the chosen basis.
  const [weekFrom, setWeekFrom] = useState("");
  const [weekTo, setWeekTo] = useState("");
  const [basis, setBasis] = useState("install");

  const { data, isLoading, error } = useQuery({
    queryKey: ["weekly-job-sheet"], queryFn: productionApi.weeklyJobSheet, enabled: allowed, staleTime: 60_000, refetchInterval: 5 * 60_000,
  });

  const refresh = useMutation({
    mutationFn: productionApi.refresh,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["weekly-job-sheet"] });
      qc.invalidateQueries({ queryKey: ["production-jobs"] });
      const c = r.stages?.counts;
      toast({
        title: "Refreshed from JobProgress",
        description: c ? `${c.jobs_examined} jobs in tracked stages; money read for ${(c.financials_from_listing ?? 0) + (c.financial_summaries_fetched ?? 0)}.` : "Updated.",
      });
    },
    onError: (err) => toast({ title: "Refresh failed", description: err.message, variant: "destructive" }),
  });

  const inWeek = (day) => !!day && (!weekFrom || day >= weekFrom) && (!weekTo || day <= weekTo);
  const officeDay = (iso) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : null);
  const weekMatch = (r) => {
    if (!weekFrom && !weekTo) return true;
    const byInstall = (r.installDates ?? []).some(inWeek);
    const bySale = inWeek(r.saleDate);
    const byStage = inWeek(officeDay(r.stageSince));
    return basis === "install" ? byInstall : basis === "sale" ? bySale : basis === "stage" ? byStage : byInstall || bySale || byStage;
  };

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    return all
      .filter((r) => !group || r.stageGroup === group)
      .filter(weekMatch)
      .filter((r) => !onlyGaps || r.gross == null || r.totalPayments == null || !r.salesRep || !r.saleDate
        || (Number(r.totalPayments) > 0 && r.paymentsCount === 0))
      .filter((r) => !q || [r.jobNumber, r.customer, r.city, r.address, r.division, r.salesRep, r.sub, r.stage]
        .some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [data, group, search, weekFrom, weekTo, basis, onlyGaps]); // eslint-disable-line react-hooks/exhaustive-deps

  const excelUrl = `/api/production/weekly-job-sheet.xlsx${qs({ from: weekFrom, to: weekTo, basis: weekFrom || weekTo ? basis : "" })}`;

  const gaps = useMemo(() => (data?.rows ?? []).filter((r) => r.gross == null).length, [data]);

  function downloadCsv() {
    const csv = toSheetCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weekly-job-sheet-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "CSV downloaded", description: `${rows.length} rows in the master sheet's column order (A–AB).` });
  }

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">Production access required.</div>;

  const cell = (c, r) => {
    const v = r[c.key];
    if (v == null || v === "") return <span className="text-muted-foreground">—</span>;
    if (c.type === "date") return sheetDate(v);
    if (c.type === "money") return money(v);
    return String(v);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Weekly Job Sheet</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            The production master sheet's <strong>WEEKLY JOB SHEET</strong> tab, filled from JobProgress: one row per job currently in a
            Project Won, Production or Warranty stage. Column letters match the tab, and the CSV download is in the tab's column order
            so it can be pasted straight over it.
            {data?.sync && <span className={data.sync.status === "completed" ? "" : "text-red-600"}> Synced every 10 minutes; updated {relative(data.sync.finishedAt || data.sync.startedAt)}.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
            className="flex items-center gap-2 bg-white border border-border hover:bg-secondary disabled:opacity-50 text-sm font-semibold px-3 py-2 rounded-lg">
            {refresh.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh from JobProgress
          </button>
          <button onClick={downloadCsv} disabled={rows.length === 0}
            className="flex items-center gap-2 bg-white border border-border hover:bg-secondary disabled:opacity-50 text-sm font-semibold px-3 py-2 rounded-lg">
            <Download className="w-4 h-4" /> CSV
          </button>
          <a href={excelUrl} title="Excel workbook in the master sheet's layout, with the week filter applied"
            className="flex items-center gap-2 bg-primary text-primary-foreground hover:opacity-90 text-sm font-semibold px-3 py-2 rounded-lg">
            <Download className="w-4 h-4" /> Download Excel
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Jobs", value: rows.length.toLocaleString() },
          { label: "Total Rev w/ C.O.s", value: money(sum(rows, "totalRev")) },
          { label: "Payments Received", value: money(sum(rows, "totalPayments")) },
          { label: "Balance Owed", value: money(sum(rows, "balanceOwed")) },
        ].map((t) => (
          <div key={t.label} className="bg-white rounded-xl border border-border shadow-sm p-4">
            <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">{t.label}</div>
            <div className="text-2xl font-heading font-bold mt-1">{t.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm p-3 flex flex-wrap items-center gap-2">
        <select value={group} onChange={(e) => setGroup(e.target.value)} className="border border-input rounded-lg px-2 py-1 text-sm bg-white">
          <option value="">All tracked stages</option>
          {STAGE_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Week</span>
          <input type="date" value={weekFrom} onChange={(e) => setWeekFrom(e.target.value)} className="border border-input rounded-lg px-2 py-1 text-sm bg-white" />
          <span className="text-muted-foreground">to</span>
          <input type="date" value={weekTo} onChange={(e) => setWeekTo(e.target.value)} className="border border-input rounded-lg px-2 py-1 text-sm bg-white" />
        </label>
        <select value={basis} onChange={(e) => setBasis(e.target.value)} disabled={!weekFrom && !weekTo}
          title="What puts a job in the week" className="border border-input rounded-lg px-2 py-1 text-sm bg-white disabled:opacity-50">
          <option value="install">Install scheduled in week</option>
          <option value="sale">Sold in week</option>
          <option value="stage">Stage changed in week</option>
          <option value="any">Any of those</option>
        </select>
        {(weekFrom || weekTo) && <button onClick={() => { setWeekFrom(""); setWeekTo(""); }} className="text-xs text-accent font-semibold">Clear week</button>}
        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />
          Only rows with gaps
        </label>
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Job #, customer, town, rep, sub…"
            className="border border-input rounded-lg pl-7 pr-2 py-1 text-sm bg-white w-64" />
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error.message}</div>}

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {data?.rows?.length ? "No jobs match these filters." : "No jobs synced yet — press Refresh from JobProgress."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-max">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-secondary/40">
                  {VISIBLE.map((c) => (
                    <th key={c.key} className={`px-3 py-2 whitespace-nowrap ${c.type === "money" ? "text-right" : ""}`}>
                      {c.label}{c.col && <span className="ml-1 text-[10px] font-mono text-muted-foreground/70">{c.col}</span>}
                    </th>
                  ))}
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.jobId} className="border-b border-border/50 hover:bg-secondary/30">
                    {VISIBLE.map((c) => (
                      <td key={c.key} className={`px-3 py-2 whitespace-nowrap ${c.type === "money" ? "text-right tabular-nums" : ""} ${c.key === "label" ? "font-semibold text-primary" : ""} ${c.key === "jobNumber" ? "text-xs" : ""}`}>
                        {cell(c, r)}
                        {c.key === "label" && r.insurance && <span className="ml-1 text-[10px] font-bold px-1.5 rounded bg-indigo-100 text-indigo-700">INS</span>}
                      </td>
                    ))}
                    <td className="px-3 py-2">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border flex flex-wrap gap-x-4 gap-y-1">
            <span>{rows.length} job{rows.length === 1 ? "" : "s"} · newest sale first</span>
            {gaps > 0 && <span className="text-amber-700">{gaps} job{gaps === 1 ? "" : "s"} still waiting for money figures from JobProgress (filled within ~10 minutes of syncing).</span>}
          </div>
        )}
      </div>

      <div className="bg-secondary/40 border border-border rounded-xl p-4 text-xs text-muted-foreground flex gap-2">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div>
            <strong>Filled from JobProgress:</strong> {SHEET_COLUMNS.filter((c) => c.key && !c.pending).map((c) => `${c.col} ${c.header}`).join(" · ")}.
            Column A is built as Town/Address/Customer from the JobProgress job address and customer; the job number goes in AC.
            Sub falls back to the crews on the job's production schedules when no sub-contractor is set on the job itself.
          </div>
          <div>
            <strong>Payments</strong> come from the job's Payment History in JobProgress: Deposit is the first payment recorded, Progress
            Payments are every later one, Payment Method lists the methods used (Cash/Check…). Canceled payments are ignored.
            A job whose payment total changed is re-read within ~10 minutes.
          </div>
          <div>
            <strong>Vendor bills</strong> fill Material Vendor (the suppliers that billed the job, in the sheet's short names), Container
            Scheduled (a carting company billed) and the Actual Material / Labor / Carting / Other cost columns. Bills appear after
            delivery, so a job in progress shows them as they arrive. Sub Scheduled is ticked when a production visit has a crew.
          </div>
          {PENDING_COLUMNS.length > 0 && (
            <div><strong>Not yet available from JobProgress:</strong> {PENDING_COLUMNS.map((c) => `${c.col} ${c.header}`).join(" · ")}. These export blank.</div>
          )}
          <div><strong>Still filled by hand:</strong> the checkbox columns B–J, Lender (V–X), SQs and Material Vendor.</div>
        </div>
      </div>
    </div>
  );
}
