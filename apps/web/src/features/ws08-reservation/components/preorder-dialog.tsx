// Event pre-order picker (PRD §3.22 "Pre-order Event"): the staff attaches one
// active menu package to the reservation. The package price is per person and
// excludes tax and service charge (owner decision, 1 Nov 2026); the contract
// stores the subtotal it computes for this party.
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
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "cn";
import type {
  Reservation,
  ReservationPackage,
} from "@starter/shared/reservation";
import { reservationErrorKey } from "../lib";
import { usePackages, usePlacePreOrder } from "../hooks";

/** §3.22: a package is orderable inside its pax range and before its lead time. */
export function packageAvailable(
  pack: ReservationPackage,
  input: { pax: number; reservedFor: string; now: number },
): boolean {
  if (pack.status !== "active") return false;
  if (input.pax < pack.minPax || input.pax > pack.maxPax) return false;
  const hours = (Date.parse(input.reservedFor) - input.now) / 3_600_000;
  return hours >= pack.leadTimeHours;
}

export function PreOrderDialog({
  open,
  onOpenChange,
  outletId,
  reservation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  reservation: Reservation;
}) {
  const t = useT();
  const toast = useToast();
  const packages = usePackages(outletId);
  const place = usePlacePreOrder();
  const [selectedId, setSelectedId] = React.useState<
    ReservationPackage["id"] | null
  >(null);
  // One clock read per mount: the lead-time check must not drift mid-dialog.
  const [now] = React.useState(() => Date.now());
  const rows = packages.data ?? [];
  const error = place.error ? t(reservationErrorKey(place.error)) : null;

  const submit = () => {
    if (!selectedId) return;
    place.mutate(
      { outletId, reservationId: reservation.id, packageId: selectedId },
      {
        onSuccess: () => {
          toast({ title: t("reservation.preOrder.success"), tone: "success" });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("reservation.preOrder.title")}</DialogTitle>
          <DialogDescription>
            {t("reservation.preOrder.hint")}
          </DialogDescription>
        </DialogHeader>

        {packages.isPending ? (
          <div aria-busy="true" className="grid gap-2">
            <span className="sr-only" role="status">
              {t("reservation.preOrder.loading")}
            </span>
            {Array.from({ length: 2 }, (_, index) => (
              <Skeleton key={index} className="h-28 w-full rounded-container" />
            ))}
          </div>
        ) : packages.error ? (
          <ErrorState
            title={t("reservation.preOrder.errorTitle")}
            description={t("reservation.preOrder.errorHint")}
            onRetry={() => void packages.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("reservation.preOrder.emptyTitle")}
            description={t("reservation.preOrder.emptyHint")}
          />
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {rows.map((pack) => {
              const available = packageAvailable(pack, {
                pax: reservation.pax,
                reservedFor: reservation.reservedFor,
                now,
              });
              const selected = selectedId === pack.id;
              return (
                <li key={pack.id} className="min-w-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    disabled={!available}
                    onClick={() => setSelectedId(pack.id)}
                    className={cn(
                      "grid w-full gap-1 rounded-container border-(length:--border-w) bg-card p-card text-left text-foreground transition-colors duration-(--duration-fast)",
                      "hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      selected && "border-primary bg-primary-tint",
                      !available &&
                        "cursor-not-allowed opacity-60 hover:bg-card",
                    )}
                  >
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-base font-semibold">
                        {pack.name}
                      </span>
                      <span className="flex items-baseline gap-1">
                        <Money
                          amount={pack.pricePerPaxIdr}
                          size="sm"
                          className="font-semibold"
                        />
                        <span className="text-xs text-muted-foreground">
                          {t("reservation.preOrder.perPax")}
                        </span>
                      </span>
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {pack.description}
                    </span>
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular">
                      <span>
                        {t("reservation.preOrder.paxRange", {
                          min: pack.minPax,
                          max: pack.maxPax,
                        })}
                      </span>
                      <span>
                        {t("reservation.preOrder.leadTime", {
                          hours: pack.leadTimeHours,
                        })}
                      </span>
                      <span>
                        {t("reservation.preOrder.items", {
                          count: pack.items.length,
                        })}
                      </span>
                    </span>
                    {available ? (
                      <span className="flex flex-wrap items-baseline gap-1 text-sm font-semibold tabular">
                        {t("reservation.preOrder.subtotal", {
                          pax: reservation.pax,
                        })}
                        <Money
                          amount={pack.pricePerPaxIdr * reservation.pax}
                          size="sm"
                          className="font-semibold"
                        />
                      </span>
                    ) : (
                      <span className="text-sm font-semibold text-warning">
                        {t("reservation.preOrder.unavailable")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
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
            loading={place.isPending}
            disabled={selectedId === null}
            onClick={submit}
          >
            {t("reservation.preOrder.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
