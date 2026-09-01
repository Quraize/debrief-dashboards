const RATING_BG = {
  green: "bg-green-50 border-green-300",
  yellow: "bg-amber-50 border-amber-300",
  red: "bg-red-50 border-red-300",
};

const RATING_TEXT = {
  green: "text-green-700",
  yellow: "text-amber-700",
  red: "text-red-700",
};

/**
 * @param {{ label: React.ReactNode, value: React.ReactNode, accent?: boolean,
 *           rating?: "green"|"yellow"|"red"|null, title?: string }} props
 */
export default function KpiCard({ label, value, accent, rating, title }) {
  const bg = rating ? RATING_BG[rating] : "border-border bg-white";
  const text = rating ? RATING_TEXT[rating] : "text-primary";
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${bg} ${accent && !rating ? "ring-2 ring-accent/40" : ""}`} title={title || ""}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold leading-tight">{label}</div>
      <div className={`text-2xl font-heading font-bold mt-1 ${text}`}>{value}</div>
    </div>
  );
}