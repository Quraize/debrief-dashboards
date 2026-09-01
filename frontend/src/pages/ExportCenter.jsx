import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { buildExportRows, toCSV } from "@allied/shared/kpi";
import { salesAppointmentsOnly } from "@allied/shared/salesAppointment";
import { isInsuranceDebrief, insuranceDebriefs, nonInsuranceAppointments } from "@allied/shared/insurance";
import { Download, Loader2, FileSpreadsheet, CheckCircle2, Shield } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

export default function ExportCenter() {
  const { toast } = useToast();
  const [exported, setExported] = useState(false);
  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });

  const rows = buildExportRows(debriefs, salesAppointmentsOnly(nonInsuranceAppointments(appointments)));
  const insuranceRows = buildExportRows(debriefs, appointments, isInsuranceDebrief);
  const insuranceCount = insuranceDebriefs(debriefs).length;

  function downloadCSV() {
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `debrief-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
    toast({ title: "CSV exported", description: `${rows.length} rows ready for Google Sheets.` });
  }

  function downloadInsuranceCSV() {
    const csv = toCSV(insuranceRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `insurance-debrief-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Insurance CSV exported", description: `${insuranceRows.length} insurance rows.` });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Export / Sync Center</h1>
        <p className="text-sm text-muted-foreground">Export debrief data matching your master Google Sheet.</p>
      </div>

      <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-green-100 rounded-lg w-12 h-12 flex items-center justify-center">
            <FileSpreadsheet className="w-6 h-6 text-green-600" />
          </div>
          <div>
            <div className="font-heading font-bold text-primary">Debrief Export for Google Sheets</div>
            <div className="text-sm text-muted-foreground">{rows.length} rows • {rows.length ? Object.keys(rows[0]).length : 33} columns matching master sheet</div>
          </div>
        </div>

        <button onClick={downloadCSV} disabled={isLoading || !rows.length}
          className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 text-lg transition-colors">
          {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
          Download CSV
        </button>

        {exported && (
          <div className="flex items-center gap-2 text-sm text-green-600 font-semibold">
            <CheckCircle2 className="w-4 h-4" /> CSV ready — paste into the "Debrief Responses" tab of your master Google Sheet.
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-100 rounded-lg w-12 h-12 flex items-center justify-center">
            <Shield className="w-6 h-6 text-indigo-600" />
          </div>
          <div>
            <div className="font-heading font-bold text-primary">Insurance Debrief Export</div>
            <div className="text-sm text-muted-foreground">{insuranceRows.length} insurance rows • includes all Insurance-specific fields</div>
          </div>
        </div>
        <button onClick={downloadInsuranceCSV} disabled={isLoading || !insuranceRows.length}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 text-lg transition-colors">
          {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
          Download Insurance CSV
        </button>
        {insuranceRows.length === 0 && !isLoading && (
          <p className="text-xs text-muted-foreground text-center">No insurance debriefs yet — button disabled.</p>
        )}
      </div>

      <div className="bg-green-50 border border-green-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <CheckCircle2 className="w-4 h-4 text-green-600" />
          <h2 className="font-heading font-bold text-sm text-green-800">Google Sheets Auto-Sync Active</h2>
        </div>
        <p className="text-sm text-green-700">
          New debriefs are automatically pushed to the "Debrief Responses" tab of your master Google Sheet — no manual export needed. Use the CSV download above for bulk backfills.
        </p>
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm overflow-hidden">
          <h2 className="font-heading font-bold text-sm text-primary mb-3">Preview (first 5 rows)</h2>
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="text-xs min-w-max">
              <thead>
                <tr className="bg-secondary/50">
                  {Object.keys(rows[0]).map((h) => <th key={h} className="px-2 py-1.5 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-b border-border/60">
                    {Object.values(r).map((v, j) => <td key={j} className="px-2 py-1.5 whitespace-nowrap text-primary">{String(v)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}