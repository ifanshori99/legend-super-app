// One floor-plan table as a tappable card: code, derived status, seat duration,
// guests, outstanding bill and open waiter calls. The card is the touch target
// (well over 44px) and carries an accessible name with the full state.
import { BellRing, Clock, Link2, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { cn } from "cn";
import type { TableLiveStatus } from "@starter/shared/qr-order";
import { boardStatusLabel, seatDurationOf, tableBoardStatus } from "../lib";
import { BoardStatusBadge } from "./board-status";

export function TableCard({
  row,
  now,
  shared,
  selected,
  onSelect,
}: {
  row: TableLiveStatus;
  /** Shared clock so every card's seat duration ticks together. */
  now: Date;
  /** Another table is bound to the same session (merged tables). */
  shared: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const status = tableBoardStatus(row);
  const duration = seatDurationOf(row, now, t);
  const session = row.session;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={t("floor.tableCard", {
        code: row.table.code,
        status: boardStatusLabel(status, t),
        capacity: row.table.capacity,
      })}
      aria-haspopup="dialog"
      data-table-code={row.table.code}
      data-board-status={status}
      className={cn(
        "flex min-h-32 w-full flex-col gap-2 rounded-xl border-(length:--border-w) bg-card p-card text-left text-foreground transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected && "bg-accent",
      )}
    >
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-2xl leading-8 font-bold tabular">
          {row.table.code}
        </span>
        <span className="flex items-center gap-1 text-sm text-muted-foreground tabular">
          <Users className="size-4" aria-hidden="true" />
          {row.table.capacity}
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-1.5">
        <BoardStatusBadge status={status} />
        {shared && (
          <Badge tone="brand">
            <Link2 aria-hidden="true" />
            {t("floor.merged")}
          </Badge>
        )}
        {row.openServiceRequestCount > 0 && (
          <Badge tone="danger">
            <BellRing aria-hidden="true" />
            {t("floor.waiterCalls", { count: row.openServiceRequestCount })}
          </Badge>
        )}
      </span>

      {session && (
        <span className="grid gap-0.5">
          <span className="flex items-center gap-1 text-sm text-muted-foreground tabular">
            <Clock className="size-4" aria-hidden="true" />
            {duration !== null
              ? t("floor.seatedFor", { duration })
              : t("floor.durationUnknown")}
            <span aria-hidden="true">·</span>
            {t("floor.pax", { count: session.pax })}
          </span>
          {row.outstandingIdr > 0 && (
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {t("floor.session.outstanding")}
              </span>
              <Money
                amount={row.outstandingIdr}
                size="sm"
                className="font-semibold"
              />
            </span>
          )}
        </span>
      )}
    </button>
  );
}
