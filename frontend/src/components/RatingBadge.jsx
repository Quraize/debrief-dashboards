const STYLES = {
  Excellent: "bg-green-100 text-green-700 border-green-300",
  Good: "bg-amber-100 text-amber-700 border-amber-300",
  Poor: "bg-red-100 text-red-700 border-red-300",
  "No Data": "bg-secondary text-muted-foreground border-border",
};

export default function RatingBadge({ rating }) {
  return (
    <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${STYLES[rating] || STYLES["No Data"]}`}>
      {rating}
    </span>
  );
}