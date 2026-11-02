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
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
      <Skeleton className="h-14 w-full rounded-container" />
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-24 w-full rounded-container" />
      ))}
    </div>
  );
}

export function ScheduleTab({
  outletId,
  timeZone,
  date,
  status,
  selectedId,
  onDateChange,
  onStatusChange,
  onOpen,
}: {
  outletId: string;
  timeZone: string;
  date: string | undefined;
  status: ReservationStatus | undefined;
  /** The reservation whose detail sheet is open, for the selected row. */
  selectedId: string | undefined;
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
  const summary = [
    { key: "reservation.summary.total" as const, value: rows.length },
    {
      key: "reservation.summary.pending" as const,
      value: counts.pending_deposit,
    },
    {
      key: "reservation.summary.confirmed" as const,
      value: counts.confirmed,
    },
    { key: "reservation.summary.seated" as const, value: counts.seated },
  ];
  /**
   * RSV-01 on the row itself: one of *its* tables is also held by another live
   * reservation in the same slot.
   */
  const hasConflict = (reservation: (typeof rows)[number]) => {
    const taken = conflictingReservations(reservation, rows);
    return reservation.tableIds.some((tableId) => taken.has(tableId));
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

      <div className="flex flex-wrap items-end gap-2">
        {/* Mobile: the date keeps its narrow column and the status select gets
            the rest, so "Semua status" never truncates. From sm they are two
            fixed fields in one row. */}
        <div className="grid min-w-0 grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2 sm:flex sm:gap-2">
          <div className="grid min-w-0 gap-1 sm:w-40">
            <Label htmlFor="reservation-date" className="max-sm:sr-only">
              {t("reservation.filters.dateLabel")}
            </Label>
            <Input
              id="reservation-date"
              type="date"
              value={date ?? ""}
              onChange={(event) =>
                onDateChange(
                  event.target.value === "" ? undefined : event.target.value,
                )
              }
              className="w-full sm:w-40"
            />
          </div>
          <div className="grid min-w-0 gap-1 sm:w-48">
            <Label htmlFor="reservation-status" className="max-sm:sr-only">
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
              <SelectTrigger id="reservation-status" className="w-full sm:w-48">
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
      </div>

      <dl
        aria-label={t("reservation.summary.label")}
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-container border-(length:--border-w) bg-card px-4 py-3"
      >
        {summary.map((item) => (
          <div key={item.key} className="flex items-baseline gap-2">
            <dt className="type-eyebrow text-muted-foreground">
              {t(item.key)}
            </dt>
            <dd className="text-xl leading-7 font-bold tabular">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>

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
              <h2 className="type-eyebrow text-muted-foreground">
                {dayHeading(group.date, today, t)}{" "}
                <span className="tabular">
                  ({t("reservation.list.total", { count: group.rows.length })})
                </span>
              </h2>
              <div className="overflow-hidden rounded-container border-(length:--border-w) bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">
                        {t("reservation.detail.when")}
                      </TableHead>
                      <TableHead>{t("reservation.detail.paxLabel")}</TableHead>
                      <TableHead numeric className="w-32">
                        {t("reservation.detail.depositTitle")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((reservation) => (
                      <ReservationRow
                        key={reservation.id}
                        reservation={reservation}
                        timeZone={timeZone}
                        tableCodes={tableCodes}
                        conflict={hasConflict(reservation)}
                        selected={reservation.id === selectedId}
                        onOpen={() => onOpen(reservation.id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
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
