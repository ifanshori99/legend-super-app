// Table assignment for one reservation (PRD §3.22 "Penugasan Meja", RSV-01).
// The picker shows the outlet's floor plan per zone; tables another reservation
// holds during the same half-open slot are highlighted and cannot be chosen.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { TableId } from "@starter/shared/qr-order";
import type { Reservation } from "@starter/shared/reservation";
import {
  conflictingReservations,
  formatClock,
  reservationErrorKey,
  selectedSeats,
  seatsMissing,
} from "../lib";
import { RESERVATION_PAGE_SIZE } from "../api";
import { useAssignTables, useFloorPlan, useReservations } from "../hooks";
import { TablePicker } from "./table-picker";

export function AssignTablesDialog({
  open,
  onOpenChange,
  outletId,
  timeZone,
  reservation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  timeZone: string;
  reservation: Reservation;
}) {
  const t = useT();
  const toast = useToast();
  const floor = useFloorPlan(outletId);
  // Every upcoming reservation is a candidate conflict: a closed one released
  // its slots, and a past one cannot overlap this slot.
  const others = useReservations(outletId, { limit: RESERVATION_PAGE_SIZE });
  const assign = useAssignTables();
  // The parent mounts this dialog on open, so the selection always starts from
  // what the reservation holds right now.
  const [selected, setSelected] = React.useState<TableId[]>([
    ...reservation.tableIds,
  ]);

  const conflicts = React.useMemo(
    () => conflictingReservations(reservation, others.data?.data ?? []),
    [reservation, others.data],
  );

  const seats = selectedSeats(
    floor.data?.tables.map((row) => row.table) ?? [],
    selected,
  );
  const missing = seatsMissing(reservation.pax, seats);
  const error = assign.error ? t(reservationErrorKey(assign.error)) : null;

  const submit = () => {
    if (selected.length === 0) {
      toast({ title: t("reservation.assign.noneSelected"), tone: "danger" });
      return;
    }
    assign.mutate(
      {
        outletId,
        reservationId: reservation.id,
        tableIds: selected,
      },
      {
        onSuccess: () => {
          toast({ title: t("reservation.assign.saved"), tone: "success" });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("reservation.assign.title")}</DialogTitle>
          <DialogDescription>{t("reservation.assign.hint")}</DialogDescription>
        </DialogHeader>

        {floor.isPending ? (
          <div
            aria-busy="true"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            <span className="sr-only" role="status">
              {t("reservation.assign.loading")}
            </span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-container" />
            ))}
          </div>
        ) : floor.error ? (
          <ErrorState
            error={floor.error}
            title={t("reservation.assign.errorTitle")}
            description={t("reservation.assign.errorHint")}
            onRetry={() => void floor.refetch()}
          />
        ) : floor.data.tables.length === 0 ? (
          <EmptyState
            title={t("reservation.assign.emptyTitle")}
            description={t("reservation.assign.emptyHint")}
          />
        ) : (
          <div className="grid min-w-0 gap-3">
            <TablePicker
              tables={floor.data.tables.map((row) => row.table)}
              zones={floor.data.zones}
              conflicts={conflicts}
              value={selected}
              onChange={setSelected}
              formatTime={(instant) => formatClock(instant, timeZone)}
            />
            <div className="grid gap-1 text-sm">
              <p className="font-semibold tabular">
                {t("reservation.assign.selectedCount", {
                  count: selected.length,
                })}
              </p>
              <p
                className={
                  missing > 0
                    ? "text-warning tabular"
                    : "text-muted-foreground tabular"
                }
              >
                {missing > 0
                  ? t("reservation.assign.seatsShort", {
                      seats,
                      pax: reservation.pax,
                      missing,
                    })
                  : t("reservation.assign.seatsEnough", {
                      seats,
                      pax: reservation.pax,
                    })}
              </p>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("reservation.assign.close")}
          </Button>
          <Button
            type="button"
            loading={assign.isPending}
            disabled={floor.isPending || floor.error !== null}
            onClick={submit}
          >
            {t("reservation.assign.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
