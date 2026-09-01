export default function StatTable({ columns, rows, emptyText = "No records" }) {
  if (!rows.length) {
    return <div className="text-center text-muted-foreground py-8 text-sm">{emptyText}</div>;
  }
  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <table className="w-full text-sm min-w-max">
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            {columns.map((c) => (
              <th key={c.key} className="text-left font-semibold text-muted-foreground px-3 py-2 whitespace-nowrap text-xs uppercase tracking-wide">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 hover:bg-secondary/30">
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-2 whitespace-nowrap font-medium text-primary">{r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}