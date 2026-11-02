// Seating a walk-in from the waitlist (PRD §3.22 "Waitlist Walk-in"): choose
// the tables on the floor plan, then the contract opens the table session.
// Tables inside another reservation's live slot are highlighted and locked.
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
import type { WaitlistEntry } from "@starter/shared/reservation";
import { RESERVATION_PAGE_SIZE } from "../api";
import {
  formatClock,
  reservationErrorKey,
  selectedSeats,
  seatsMissing,
  tablesHeldAt,
} from "../lib";
import { useFloorPlan, useReservations, useResolveWaitlistEntry } from "../hooks";
import { TablePicker } from "./table-picker";

export function SeatWaitlistDialog({
  entry,
  onOpenChange,
  outletId,
  timeZone,
}: {
  entry: WaitlistEntry | null;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  timeZone: string;
}) {
  const t = useT();
  const toast = useToast();
  const floor = useFloorPlan(outletId);
  const others = useReservations(outletId, { limit: RESERVATION_PAGE_SIZE });
  const resolve = useResolveWaitlistEntry();
  const [selected, setSelected] = React.useState<TableId[]>([]);

  // A walk-in sits now: only reservations holding a slot at this instant block
  // a table (RSV-01 is about the reserved window, not today's whole board).
  const conflicts = React.useMemo(
    () => tablesHeldAt(others.data?.data ?? [], new Date().toISOString()),
    [others.data],
  );

  React.useEffect(() => {
    if (entry) setSelected([]);
  }, [entry]);

  const seats = selectedSeats(
    floor.data?.tables.map((row) => row.table) ?? [],
    selected,
  );
  const missing = seatsMissing(entry?.pax ?? 0, seats);
  const error = resolve.error ? t(reservationErrorKey(resolve.error)) : null;

  const submit = () => {
    if (!entry || selected.length === 0) return;
    resolve.mutate(
      {
        outletId,
        entryId: entry.id,
        resolution: "seated",
        tableIds: selected,
      },
      {
        onSuccess: () => {
          toast({
            title: t("reservation.waitlist.resolveSuccess"),
            tone: "success",
          });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {entry ? t("reservation.waitlist.seatTitle", { name: entry.name }) : ""}
          </DialogTitle>
          <DialogDescription>
            {t("reservation.assign.hint")}
          </DialogDescription>
        </DialogHeader>

        {floor.isPending ? (
          <div aria-busy="true" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <span className="sr-only" role="status">
              {t("reservation.assign.loading")}
            </span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : floor.error ? (
          <ErrorState
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
            {entry && (
              <p
                className={
                  missing > 0
                    ? "text-sm text-warning tabular"
                    : "text-sm text-muted-foreground tabular"
                }
              >
                {missing > 0
                  ? t("reservation.assign.seatsShort", {
                      seats,
                      pax: entry.pax,
                      missing,
                    })
                  : t("reservation.assign.seatsEnough", {
                      seats,
                      pax: entry.pax,
                    })}
              </p>
            )}
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
            {t("common.close")}
          </Button>
          <Button
            type="button"
            loading={resolve.isPending}
            disabled={selected.length === 0}
            onClick={submit}
          >
            {t("reservation.waitlist.seat")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
