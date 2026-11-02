// One reservation on the day's schedule: time first (the host scans by time),
// then guest, party size, tables and DP. The whole card is the touch target and
// opens the detail sheet.
import { TriangleAlert, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import type { Reservation } from "@starter/shared/reservation";
import { formatClock } from "../lib";
import { DepositBadge, ReservationStatusBadge } from "./status-badges";

export function ReservationRow({
  reservation,
  timeZone,
  tableCodes,
  conflict,
  onOpen,
}: {
  reservation: Reservation;
  timeZone: string;
  tableCodes: ReadonlyMap<string, string>;
  /** RSV-01: the row's tables overlap another reservation's slot. */
  conflict: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("reservation.list.openDetail", {
        name: reservation.guestName,
      })}
      data-reservation-id={reservation.id}
      data-status={reservation.status}
      className="grid w-full gap-2 rounded-xl border-(length:--border-w) bg-card p-card text-left text-foreground transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-start sm:gap-3"
    >
      <span className="flex items-baseline gap-2 sm:grid sm:gap-0">
        <span className="text-xl leading-8 font-bold tabular">
          {formatClock(reservation.reservedFor, timeZone)}
        </span>
        <span className="text-xs text-muted-foreground tabular">
          {t("reservation.list.duration", {
            minutes: reservation.durationMinutes,
          })}
        </span>
      </span>

      <span className="grid min-w-0 gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-base font-semibold">
            {reservation.guestName}
          </span>
          <ReservationStatusBadge status={reservation.status} />
          {conflict && (
            <Badge tone="danger" title={t("reservation.list.conflictHint")}>
              <TriangleAlert aria-hidden="true" />
              {t("reservation.list.conflict")}
            </Badge>
          )}
        </span>
        <span className="flex items-center gap-1 text-sm text-muted-foreground tabular">
          <Users className="size-4" aria-hidden="true" />
          {t("reservation.list.pax", { count: reservation.pax })}
          {reservation.tableIds.length === 0 ? (
            <>
              <span aria-hidden="true">·</span>
              {t("reservation.list.noTables")}
            </>
          ) : (
            <>
              <span aria-hidden="true">·</span>
              {t("reservation.list.tables", {
                codes: reservation.tableIds
                  .map((tableId) => tableCodes.get(tableId) ?? tableId)
                  .join(", "),
              })}
            </>
          )}
        </span>
      </span>

      <span className="flex flex-wrap items-center justify-between gap-2 sm:flex-col sm:items-end">
        <DepositBadge
          status={reservation.depositStatus}
          hasDeposit={reservation.depositIdr > 0}
        />
        <Money
          amount={reservation.depositIdr}
          size="sm"
          className="font-semibold"
        />
      </span>
    </button>
  );
}
