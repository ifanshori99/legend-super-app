// The day schedule: a business-date filter, a status filter, real counts and
// the reservations grouped by day. Every reservation opens the detail sheet
// where tables are assigned and the guest is seated (RSV-01).
import * as React from "react";
import { WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import {
  RESERVATION_STATUSES,
  type ReservationStatus,
} from "@starter/shared/reservation";
import { useOnline } from "@/lib/use-online";
import { RESERVATION_PAGE_SIZE } from "../api";
import {
  conflictingReservations,
  countByStatus,
  dayHeading,
  groupByBusinessDate,
  reservationStatusKey,
  todayInZone,
} from "../lib";
import { useFloorPlan, useReservations } from "../hooks";
import { ReservationRow } from "./reservation-row";

const ALL_STATUSES = "all";

const STATUS_OPTIONS = RESERVATION_STATUSES;

function ScheduleSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only" role="status">
        {t("reservation.list.loading")}
      </span>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-control w-44" />
        <Skeleton className="h-control w-40" />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function ScheduleTab({
  outletId,
  timeZone,
  date,
  status,
  onDateChange,
  onStatusChange,
  onOpen,
}: {
  outletId: string;
  timeZone: string;
  date: string | undefined;
  status: ReservationStatus | undefined;
  onDateChange: (date: string | undefined) => void;
  onStatusChange: (status: ReservationStatus | undefined) => void;
  onOpen: (reservationId: string) => void;
}) {
  const t = useT();
  const online = useOnline();
  const reservations = useReservations(outletId, {
    limit: RESERVATION_PAGE_SIZE,
    ...(date ? { date } : {}),
    ...(status ? { status } : {}),
  });
  const floor = useFloorPlan(outletId);
  const today = todayInZone(timeZone);
  const filtered = date !== undefined || status !== undefined;

  const tableCodes = React.useMemo(
    () =>
      new Map(
        (floor.data?.tables ?? []).map((row) => [row.table.id, row.table.code]),
      ),
    [floor.data],
  );

  if (reservations.isPending) return <ScheduleSkeleton />;

  if (reservations.error)
    return (
      <ErrorState
        title={t("reservation.list.errorTitle")}
        description={t("reservation.list.errorHint")}
        onRetry={() => void reservations.refetch()}
      />
    );

  const rows = reservations.data.data;
  const counts = countByStatus(rows);
  const groups = groupByBusinessDate(rows, timeZone);
  const nextCursor = reservations.data.meta.nextCursor;
  const resetFilters = () => {
    onDateChange(undefined);
    onStatusChange(undefined);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {!online && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">
              {t("reservation.list.offlineTitle")}
            </span>{" "}
            {t("reservation.list.offlineHint")}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor="reservation-date">
            {t("reservation.filters.dateLabel")}
          </Label>
          <Input
            id="reservation-date"
            type="date"
            value={date ?? ""}
            onChange={(event) =>
              onDateChange(event.target.value === "" ? undefined : event.target.value)
            }
            className="w-44"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onDateChange(today)}
            disabled={date === today}
          >
            {t("reservation.filters.today")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onDateChange(undefined)}
            disabled={date === undefined}
          >
            {t("reservation.filters.clearDate")}
          </Button>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="reservation-status">
            {t("reservation.filters.statusLabel")}
          </Label>
          <Select
            value={status ?? ALL_STATUSES}
            onValueChange={(value) =>
              onStatusChange(
                value === ALL_STATUSES
                  ? undefined
                  : (value as ReservationStatus),
              )
            }
          >
            <SelectTrigger id="reservation-status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>
                {t("reservation.filters.allStatuses")}
              </SelectItem>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(reservationStatusKey(option))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground tabular" aria-live="polite">
          {t("reservation.filters.count", { count: rows.length })}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile
          label={t("reservation.summary.total")}
          value={<span className="tabular">{rows.length}</span>}
        />
        <StatTile
          label={t("reservation.summary.pending")}
          value={<span className="tabular">{counts.pending_deposit}</span>}
        />
        <StatTile
          label={t("reservation.summary.confirmed")}
          value={<span className="tabular">{counts.confirmed}</span>}
        />
        <StatTile
          label={t("reservation.summary.seated")}
          value={<span className="tabular">{counts.seated}</span>}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={t("reservation.list.emptyTitle")}
          description={t("reservation.list.emptyHint")}
          action={
            filtered ? (
              <Button type="button" variant="outline" onClick={resetFilters}>
                {t("reservation.filters.reset")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-5">
          {groups.map((group) => (
            <section key={group.date} className="grid gap-2">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                {dayHeading(group.date, today, t)}{" "}
                <span className="tabular">
                  ({t("reservation.list.total", { count: group.rows.length })})
                </span>
              </h2>
              <ul className="grid list-none gap-2 p-0">
                {group.rows.map((reservation) => (
                  <li key={reservation.id} className="min-w-0">
                    <ReservationRow
                      reservation={reservation}
                      timeZone={timeZone}
                      tableCodes={tableCodes}
                      conflict={
                        conflictingReservations(reservation, rows).size > 0
                      }
                      onOpen={() => onOpen(reservation.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {nextCursor !== null && (
        <p className="text-sm text-muted-foreground">
          {t("reservation.list.moreNote", { count: rows.length })}
        </p>
      )}
    </div>
  );
}
