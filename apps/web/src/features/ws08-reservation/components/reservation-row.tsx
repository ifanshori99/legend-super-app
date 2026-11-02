// One reservation on the day's schedule: time first (the host scans by time),
// then guest, party size, tables and DP. v3: a real table row (DESIGN.md §4
// Table) inside the day's card — no per-row card border, hover on `surface-2`,
// and the row whose detail is open takes the accent tint + 2px start rule
// (owner Q29). The row still opens the detail sheet from anywhere, while the
// time cell keeps a real button so the keyboard and screen readers have one
// named control per row.
import { TriangleAlert, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { TableCell, TableRow } from "@/components/ui/table";
import type { Reservation } from "@starter/shared/reservation";
import { formatClock, reservationSourceKey } from "../lib";
import { DepositBadge, ReservationStatusBadge } from "./status-badges";

export function ReservationRow({
  reservation,
  timeZone,
  tableCodes,
  conflict,
  selected,
  onOpen,
}: {
  reservation: Reservation;
  timeZone: string;
  tableCodes: ReadonlyMap<string, string>;
  /** RSV-01: the row's tables overlap another reservation's slot. */
  conflict: boolean;
  /** The detail sheet is open for this reservation. */
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <TableRow
      data-reservation-id={reservation.id}
      data-status={reservation.status}
      data-state={selected ? "selected" : undefined}
      onClick={onOpen}
      className="cursor-pointer"
    >
      <TableCell className="align-top whitespace-nowrap">
        <button
          type="button"
          aria-label={t("reservation.list.openDetail", {
            name: reservation.guestName,
          })}
          className="text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="block text-xl leading-7 font-bold tabular">
            {formatClock(reservation.reservedFor, timeZone)}
          </span>
          <span className="block text-xs font-normal text-muted-foreground tabular">
            {t("reservation.list.duration", {
              minutes: reservation.durationMinutes,
            })}
          </span>
        </button>
      </TableCell>

      <TableCell className="align-top">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-semibold">
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
        {/* Where the row is wide enough the items read as one line with dot
            separators; on a phone they wrap as separate chips of text. */}
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <Users className="size-4" aria-hidden="true" />
            {t("reservation.list.pax", { count: reservation.pax })}
          </span>
          <span className="whitespace-nowrap sm:before:mr-2 sm:before:content-['·']">
            {reservation.tableIds.length === 0
              ? t("reservation.list.noTables")
              : t("reservation.list.tables", {
                  codes: reservation.tableIds
                    .map((tableId) => tableCodes.get(tableId) ?? tableId)
                    .join(", "),
                })}
          </span>
          <span className="whitespace-nowrap sm:before:mr-2 sm:before:content-['·']">
            {t(reservationSourceKey(reservation.source))}
          </span>
        </span>
        {reservation.note && (
          <span className="mt-1 block min-w-0 truncate text-sm text-muted-foreground">
            {reservation.note}
          </span>
        )}
      </TableCell>

      <TableCell numeric className="align-top">
        <span className="flex flex-col items-end gap-1">
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
      </TableCell>
    </TableRow>
  );
}
