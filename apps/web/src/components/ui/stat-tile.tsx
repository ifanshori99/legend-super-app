// A metric that answers one question and links to the data behind it
// (PRD: "tile metrik dengan tautan ke data sumber"). No decorative deltas or
// sparklines: show a comparison only when the data source provides one.
import * as React from "react";
import { cn } from "cn";

function StatTile({
  label,
  value,
  context,
  source,
  className,
}: {
  label: string;
  /** Usually <Money> or <NumberDisplay>. */
  value: React.ReactNode;
  /** Period or scope, e.g. "Hari ini, Outlet Kemang". */
  context?: string;
  /** Link to the source data, e.g. <a href="/kelola/transaksi">Lihat transaksi</a>. */
  source?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="stat-tile"
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border-(length:--border-w) bg-card p-card",
        className,
      )}
    >
      <p className="text-sm leading-5 font-medium text-muted-foreground">
        {label}
      </p>
      <div className="truncate text-2xl leading-8 font-semibold tracking-tight tabular">
        {value}
      </div>
      {context && (
        <p className="text-sm leading-5 text-muted-foreground">{context}</p>
      )}
      {source && (
        <div className="mt-1 text-sm font-semibold text-primary [&_a]:underline [&_a]:underline-offset-4">
          {source}
        </div>
      )}
    </div>
  );
}

export { StatTile };
