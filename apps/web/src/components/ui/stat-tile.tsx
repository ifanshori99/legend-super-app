// A metric that answers one question and links to the data behind it
// (PRD: "tile metrik dengan tautan ke data sumber"). No decorative deltas or
// sparklines: show a comparison only when the data source provides one.
//
// v2 (DESIGN.md §4, owner Q30): related metrics sit in one <StatStrip> —
// one container, hairline dividers — instead of a row of separate cards. A
// lone StatTile outside a strip keeps its own border.
import * as React from "react";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";

function StatTile({
  label,
  value,
  context,
  source,
  className,
}: {
  label: string;
  /** Usually <Money size="stat"> or <NumberDisplay>. */
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
        "flex min-w-0 flex-col gap-1 rounded-container border-(length:--border-w) bg-card p-card",
        className,
      )}
    >
      <p className="text-sm leading-5 font-medium text-muted-foreground">
        {label}
      </p>
      <div className="truncate type-money-display">{value}</div>
      {context && (
        <p className="text-xs leading-4 text-muted-foreground">{context}</p>
      )}
      {source && (
        <div className="mt-2 flex w-fit items-center gap-0.5 text-sm font-semibold text-primary [&_a]:underline-offset-4 [&_a]:hover:underline">
          {source}
          <ChevronRight className="size-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/**
 * One container for 2–4 related StatTiles. Dividers are the 1px gaps over
 * the border color, so they stay hairline at every column count: one
 * column on phones, two from `sm`, `columns` from `lg`.
 */
function StatStrip({
  label,
  columns = 4,
  className,
  children,
}: {
  /** Accessible name, e.g. "Ringkasan hari ini". */
  label: string;
  columns?: 2 | 3 | 4;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-slot="stat-strip"
      className={cn(
        "grid gap-(--border-w) overflow-hidden rounded-container border-(length:--border-w) bg-border sm:grid-cols-2",
        columns === 3 && "lg:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        "*:data-[slot=stat-tile]:rounded-none *:data-[slot=stat-tile]:border-0 sm:max-lg:[&>:last-child:nth-child(odd)]:col-span-2",
        className,
      )}
    >
      {children}
    </section>
  );
}

export { StatStrip, StatTile };
