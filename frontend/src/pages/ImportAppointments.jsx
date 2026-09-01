import { useState } from "react";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, FileUp, ChevronDown, ChevronRight, Download } from "lucide-react";

export default function ImportAppointments() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState(null);
  const [showExcluded, setShowExcluded] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setResults(null);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setUploading(false);
      setImporting(true);
      const response = await base44.functions.invoke("importAppointments", { file_url });
      setResults(response.data);
      qc.invalidateQueries({ queryKey: ["appointments-all"] });
      toast({ title: "Import complete", description: `${response.data.added} new, ${response.data.updated} updated.` });
    } catch (err) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      setImporting(false);
    }
  }

  function downloadExcluded() {
    if (!results?.excludedRows?.length) return;
    const headers = ["Title", "Customer Name", "CRM Lead ID", "Appointment Date", "Time", "Reason", "Row Type"];
    const lines = [headers.join(",")];
    results.excludedRows.forEach((r) => {
      lines.push([r.title || "", r.customer_name || "", r.crm_lead_id || "", r.appointment_date || "", r.appointment_time || "", r.reason || "", r.row_type || ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `excluded-rows-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Import Appointments</h1>
        <p className="text-sm text-muted-foreground">Upload a JobProgress appointment report (CSV or Excel). Sales appointments are identified by the standalone EST token in the title.</p>
      </div>

      <div className="bg-white rounded-xl border border-border p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="bg-accent/10 rounded-lg w-12 h-12 flex items-center justify-center">
            <FileSpreadsheet className="w-6 h-6 text-accent" />
          </div>
          <div>
            <div className="font-heading font-bold text-primary">JobProgress Report</div>
            <div className="text-sm text-muted-foreground">CSV or Excel file from JobProgress export</div>
          </div>
        </div>

        <label className="block">
          <div className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:bg-secondary/50 transition-colors">
            {uploading || importing ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="w-8 h-8 animate-spin text-accent" />
                <span className="text-sm font-semibold text-muted-foreground">
                  {uploading ? "Uploading file…" : "Importing & matching records…"}
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <FileUp className="w-8 h-8 text-muted-foreground" />
                <span className="text-sm font-semibold text-primary">Tap to select a file</span>
                <span className="text-xs text-muted-foreground">CSV or Excel</span>
              </div>
            )}
          </div>
          <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFile} disabled={uploading || importing} />
        </label>

        <div className="mt-4 text-xs text-muted-foreground space-y-1">
          <p className="font-semibold">What happens on import:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Sales appointments identified by standalone <strong>EST</strong> token in title (ROOF EST, REPAIR EST, etc.)</li>
            <li>Non-EST titles (Warranty Callback, Sample, Walk Thru, Solar, etc.) imported as non-sales</li>
            <li>Header/metadata rows automatically skipped</li>
            <li>Duplicates suppressed within upload (same Job ID + date + time)</li>
            <li>Existing appointments updated by real internal ID — no duplicates created</li>
            <li>Rerunning the same report creates zero additional records</li>
          </ul>
        </div>
      </div>

      {results && (
        <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <h2 className="font-heading font-bold text-primary">Import Review</h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox label="Total Source Rows" value={results.total} color="primary" />
            <StatBox label="New (Sales)" value={results.added} color="green" />
            <StatBox label="Updated" value={results.updated} color="blue" />
            <StatBox label="Duplicates Suppressed" value={results.duplicatesSuppressed ?? results.duplicates ?? 0} color="amber" />
            <StatBox label="Excluded Non-Sales" value={results.excludedNonSales ?? 0} color="slate" />
            <StatBox label="Insurance Rows" value={results.insuranceCount ?? 0} color="indigo" />
            <StatBox label="Invalid / Header Rows" value={results.invalidHeaderRows ?? 0} color="red" />
            <StatBox label="Ambiguous" value={results.ambiguous?.length ?? 0} color="amber" />
            <StatBox label="Errors" value={results.errors?.length ?? 0} color="red" />
          </div>

          {results.excludedRows && results.excludedRows.length > 0 && (
            <div className="space-y-2">
              <button onClick={() => setShowExcluded(!showExcluded)} className="flex items-center gap-2 text-sm font-semibold text-primary hover:text-accent">
                {showExcluded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                Excluded / Deduplicated Rows ({results.excludedRows.length})
              </button>
              {showExcluded && (
                <>
                  <div className="flex justify-end">
                    <button onClick={downloadExcluded} className="flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline">
                      <Download className="w-3.5 h-3.5" /> Download CSV
                    </button>
                  </div>
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {results.excludedRows.map((r, i) => (
                      <div key={i} className={`border rounded-lg p-2 text-xs ${
                        r.row_type === "excluded_non_sales" ? "bg-slate-50 border-slate-200" :
                        r.row_type === "deduplicated" ? "bg-amber-50 border-amber-200" :
                        "bg-red-50 border-red-200"
                      }`}>
                        <div className="font-semibold text-foreground">
                          {r.customer_name || "(unnamed)"} {r.title ? `— ${r.title}` : ""}
                        </div>
                        <div className="text-muted-foreground mt-0.5">
                          {r.appointment_date || "no date"} {r.crm_lead_id ? `• ${r.crm_lead_id}` : ""} — {r.reason}
                        </div>
                        <span className="inline-block mt-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white border border-border/60">{r.row_type}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {results.missingFields && results.missingFields.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <h3 className="font-semibold text-sm text-amber-700">Flagged Rows ({results.missingFields.length})</h3>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {results.missingFields.map((f, i) => (
                  <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs">
                    <div className="font-semibold text-amber-800">{f.customer_name || "(unnamed)"} — {f.appointment_date || "no date"}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {f.flags.map((flag) => (
                        <span key={flag} className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full text-[10px] font-medium">{flag}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.errors && results.errors.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <h3 className="font-semibold text-sm text-red-700">Errors ({results.errors.length})</h3>
              </div>
              {results.errors.map((e, i) => (
                <div key={i} className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">
                  {e.error}
                </div>
              ))}
            </div>
          )}

          {results.total > 0 && (results.missingFields?.length ?? 0) === 0 && (results.errors?.length ?? 0) === 0 && (
            <div className="flex items-center gap-2 text-sm text-green-600 font-semibold">
              <CheckCircle2 className="w-4 h-4" /> All records imported cleanly — no flags or errors.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, color }) {
  const colors = {
    primary: "bg-primary/10 text-primary",
    green: "bg-green-100 text-green-700",
    blue: "bg-blue-100 text-blue-700",
    amber: "bg-amber-100 text-amber-700",
    slate: "bg-slate-100 text-slate-700",
    red: "bg-red-100 text-red-700",
    indigo: "bg-indigo-100 text-indigo-700"
  };
  return (
    <div className={`rounded-lg p-3 text-center ${colors[color] || colors.primary}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium">{label}</div>
    </div>
  );
}