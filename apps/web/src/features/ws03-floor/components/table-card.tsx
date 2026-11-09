// One floor-plan table as a tappable card: code, derived status, seat duration,
// guests, outstanding bill and open waiter calls. The card is the touch target
// (well over 44px) and carries an accessible name with the full state.
//
// v2 (owner Q25/Q27, DESIGN.md "Operations — status hierarchy"): the tile
// surface follows the state — empty = card + border, occupied = surface-3 with
// no border, cleaning = dashed, inactive = surface-2 muted. A waiter call is
// urgent: solid StatusPill, 2px border and a 6px start rule in the status color.
import { Clock, Link2, ReceiptText, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { cn } from "cn";
import type { TableLiveStatus } from "@starter/shared/qr-order";
import {
  boardStatusLabel,
  paymentModeLabel,
  seatDurationOf,
  tableBoardStatus,
  tableTileLook,
  type TableTileLook,
} from "../lib";
import { BoardStatusBadge } from "./board-status";

const SURFACE: Record<TableTileLook["surface"], string> = {
  card: "border-(length:--border-w) border-border bg-card",
  "surface-2": "border-(length:--border-w) border-border bg-surface-2",
  // Occupied tiles have no border; the warm grey alone lifts them.
  "surface-3": "bg-surface-3",
};

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
  const look = tableTileLook(row);
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
      data-tile-surface={look.surface}
      data-urgent={look.urgent || undefined}
      data-calm={look.calm || undefined}
      data-dashed={look.dashed || undefined}
      data-muted={look.muted || undefined}
      className={cn(
        "flex min-h-32 w-full flex-col gap-2 rounded-container p-card text-left text-foreground transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        SURFACE[look.surface],
        look.dashed && "border-dashed",
        look.muted && "text-muted-foreground",
        // Q25: urgent wins over the resting surface — 2px border plus a 6px
        // start rule in the danger tone, with the solid pill inside.
        look.urgent && "border-2 border-danger border-s-[6px]",
        selected && "outline-2 outline-offset-2 outline-ring",
      )}
    >
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span
          data-slot="table-code"
          className="text-3xl leading-9 font-semibold tracking-tight tabular"
        >
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
        {look.urgent && (
          <StatusPill status="danger" solid>
            {t("floor.waiterCalls", { count: row.openServiceRequestCount })}
          </StatusPill>
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
          {session.paymentMode === "open_bill" && (
            <span
              data-slot="payment-mode"
              className="flex items-center gap-1 text-sm text-muted-foreground"
            >
              <ReceiptText className="size-4" aria-hidden="true" />
              {paymentModeLabel(session.paymentMode, t)}
            </span>
          )}
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
