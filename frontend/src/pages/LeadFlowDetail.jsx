/**
 * The rows behind one Lead Flow card.
 *
 * Management reads the Overview as their bird's-eye view; this is the step
 * under it. Clicking Disqualified there lands here with the leads that were
 * disqualified, Not Set with the valid leads nobody has booked, No See with
 * the visits nobody was home for. The list comes from the same classifier as
 * the number on the card (shared/src/leadFlow.js), so the count always
 * matches what is on screen.
 *
 * Range, basis and card all live in the URL, so a manager can send the link.
 */
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { get, qs } from "@/api/http";

const money = (v) => (v == null ? "" : "$" + Math.round(Number(v) || 0).toLocaleString());
const day = (v) => {
  if (!v) return "—";
  const [y, m, d] = String(v).slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
};

export default function LeadFlowDetail() {
  const [params] = useSearchParams();
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const card = params.get("card") || "";
  const basis = params.get("basis") || "activity";
  const label = params.get("label") || "";

  const { data, isLoading, error } = useQuery({
    queryKey: ["leads-flow-detail", from, to, card, basis],
    queryFn: () => get(`/api/leads/flow/detail${qs({ from, to, card, basis })}`),
    enabled: !!from && !!to && !!card,
    staleTime: 60_000,
  });

  const rows = data?.rows ?? [];
  const isLead = data?.kind === "lead";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link to="/" className="text-xs font-semibold text-accent hover:underline inline-flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Overview
          </Link>
          <h1 className="text-2xl font-heading font-bold text-primary mt-1">{data?.label || label || "Lead Flow"}</h1>
          <p className="text-sm text-muted-foreground">
            {day(from)} – {day(to)} · {data ? `${data.count} ${isLead ? (data.count === 1 ? "lead" : "leads") : (data.count === 1 ? "visit" : "visits")}` : "loading…"}
            {basis === "cohort" ? " · leads that came in" : " · work done in this range"}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <p className="text-sm text-red-600 p-6 text-center">This list could not be loaded right now.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-6 text-center">Nothing in this group for the period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground bg-secondary/50 border-b border-border">
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 font-semibold">{isLead ? "Town / Address" : "Rep"}</th>
                  <th className="px-3 py-2 font-semibold">{isLead ? "Job #" : "Setter"}</th>
                  <th className="px-3 py-2 font-semibold">{isLead ? "Lead date" : "Visit date"}</th>
                  <th className="px-3 py-2 font-semibold">{isLead ? "Stage" : "Type"}</th>
                  <th className="px-3 py-2 font-semibold">{isLead ? "Why not set" : "Outcome"}</th>
                  {!isLead && <th className="px-3 py-2 font-semibold text-right">Amount</th>}
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/30">
                    <td className="px-3 py-2 font-semibold text-primary whitespace-nowrap">{r.customer || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{(isLead ? r.place : r.rep) || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{(isLead ? r.jobNumber : r.setter) || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {day(r.date)}
                      {r.signedDate && r.signedDate !== r.date && (
                        <span className="text-xs text-muted-foreground"> · signed {day(r.signedDate)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{(isLead ? r.stage : r.type) || "—"}</td>
                    <td className="px-3 py-2">{(isLead ? r.reason : r.outcome) || "—"}</td>
                    {!isLead && <td className="px-3 py-2 text-right tabular-nums">{money(r.amount)}</td>}
                    <td className="px-3 py-2">
                      {r.jpUrl && (
                        <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress">
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
