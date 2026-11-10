// One reservation in full: guest, slot, tables, DP, the frozen policy, the
// pre-order, and every action the status allows (PRD §3.22 "Reservasi &
// Event"; RSV-01 table assignment, RSV-02 DP, RSV-03 cancellation policy).
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  depositIsSettled,
  type Reservation,
  type ReservationPreOrder,
  type ReservationTableSlot,
} from "@starter/shared/reservation";
import {
  businessDateOf,
  formatClock,
  formatDayLabel,
  percentLabel,
  reservationActions,
  reservationErrorKey,
  reservationSourceKey,
} from "../lib";
import {
  useFloorPlan,
  useReservationDetail,
  useResendDepositLink,
  useSeatReservation,
} from "../hooks";
import { AssignTablesDialog } from "./assign-tables-dialog";
import { CloseReservationDialog } from "./close-dialog";
import { PreOrderDialog } from "./preorder-dialog";
import {
  DepositBadge,
  PreOrderStatusBadge,
  ReservationStatusBadge,
} from "./status-badges";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

function DetailBody({
  outletId,
  timeZone,
  reservation,
  preOrder,
  slots,
}: {
  outletId: string;
  timeZone: string;
  reservation: Reservation;
  preOrder: ReservationPreOrder | null;
  slots: ReservationTableSlot[];
}) {
  const t = useT();
  const toast = useToast();
  const floor = useFloorPlan(outletId);
  const seat = useSeatReservation();
  const resend = useResendDepositLink();
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [preOrderOpen, setPreOrderOpen] = React.useState(false);
  const [closeMode, setCloseMode] = React.useState<"cancel" | "noShow" | null>(
    null,
  );

  const actions = reservationActions(reservation);
  const zone = floor.data?.zones.find((item) => item.id === reservation.zoneId);
  const tableCodes = new Map(
    (floor.data?.tables ?? []).map((item) => [item.table.id, item.table.code]),
  );
  const end = new Date(
    Date.parse(reservation.reservedFor) + reservation.durationMinutes * 60_000,
  ).toISOString();
  // The contract rule, not a local copy (RSV-02): a later WS-05 refund keeps
  // the DP settled, so a refunded-DP guest can still be seated.
  const depositSettled = depositIsSettled(reservation.depositStatus);
  const seatError = seat.error ? t(reservationErrorKey(seat.error)) : null;

  // RSV-02: only a booking still waiting for its DP can get the link again.
  const canResendDeposit =
    reservation.status === "pending_deposit" && reservation.depositIdr > 0;
  const resendError = resend.error
    ? t(reservationErrorKey(resend.error))
    : null;
  const depositLink = resend.data;

  const resendDeposit = () => {
    resend.mutate({ outletId, reservationId: reservation.id });
  };

  const copyDepositLink = () => {
    if (!depositLink) return;
    const url = new URL(depositLink.paymentPath, window.location.origin).href;
    void navigator.clipboard
      ?.writeText(url)
      .then(() =>
        toast({ title: t("reservation.depositLink.copied"), tone: "success" }),
      );
  };

  const seatNow = () => {
    seat.mutate(
      {
        outletId,
        reservationId: reservation.id,
        tableIds: [...reservation.tableIds],
      },
      {
        onSuccess: () =>
          toast({ title: t("reservation.seat.success"), tone: "success" }),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{reservation.guestName}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-1">
          <ReservationStatusBadge status={reservation.status} />
          <DepositBadge reservation={reservation} />
          <Badge tone="neutral">
            {t(reservationSourceKey(reservation.source))}
          </Badge>
        </DialogDescription>
      </DialogHeader>

      <dl className="grid min-w-0 grid-cols-2 gap-3 rounded-container border-(length:--border-w) bg-card p-card">
        <Fact label={t("reservation.detail.when")}>
          <span className="tabular">
            {formatDayLabel(businessDateOf(reservation.reservedFor, timeZone))}
            <br />
            {formatClock(reservation.reservedFor, timeZone)}–
            {formatClock(end, timeZone)} ·{" "}
            {t("reservation.list.duration", {
              minutes: reservation.durationMinutes,
            })}
          </span>
        </Fact>
        <Fact label={t("reservation.detail.paxLabel")}>
          <span className="tabular">
            {t("reservation.detail.paxValue", { count: reservation.pax })}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            <Badge tone={reservation.customerProfileId ? "brand" : "neutral"}>
              {reservation.customerProfileId
                ? t("reservation.detail.member")
                : t("reservation.detail.nonMember")}
            </Badge>
          </span>
        </Fact>
        <Fact label={t("reservation.detail.tables")}>
          {reservation.tableIds.length === 0 ? (
            <span className="text-muted-foreground">
              {t("reservation.detail.noTables")}
            </span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {reservation.tableIds.map((tableId) => (
                <Badge key={tableId} tone="brand">
                  {tableCodes.get(tableId) ?? t("reservation.detail.noTables")}
                </Badge>
              ))}
            </span>
          )}
          {zone && (
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              {zone.name}
            </span>
          )}
        </Fact>
        <Fact label={t("reservation.detail.depositTitle")}>
          <span className="flex flex-wrap items-center gap-1">
            <Money amount={reservation.depositIdr} size="sm" />
            {reservation.policy.depositRequirement === "required" &&
              !depositSettled && (
                <span className="text-xs font-normal text-warning">
                  {t("reservation.seat.unpaid")}
                </span>
              )}
          </span>
        </Fact>
        <Fact label={t("reservation.detail.contact")}>
          <span className="font-normal text-muted-foreground">
            {t("reservation.detail.contactHidden")}
          </span>
        </Fact>
        {reservation.note && (
          <Fact label={t("reservation.detail.note")}>
            <span className="font-normal">{reservation.note}</span>
          </Fact>
        )}
      </dl>

      <section className="grid gap-1.5">
        <h3 className="type-heading">{t("reservation.detail.policyTitle")}</h3>
        <div className="grid gap-1.5 rounded-container bg-muted p-3 text-sm text-muted-foreground">
          <p className="tabular">
            {t("reservation.detail.policyVersion", {
              version: reservation.policy.version,
              time: formatClock(reservation.policy.capturedAt, timeZone),
            })}
          </p>
          <p className="flex items-baseline justify-between gap-3">
            <span>{t("reservation.detail.policyDepositLabel")}</span>
            {reservation.policy.depositRequirement === "none" ? (
              <span>{t("reservation.detail.policyNoDeposit")}</span>
            ) : (
              <Money
                amount={reservation.policy.depositAmountIdr}
                size="sm"
                className="font-semibold text-foreground"
              />
            )}
          </p>
          <p>
            {t("reservation.detail.policyRefundWindow", {
              hours: reservation.policy.freeCancellationHours,
            })}
          </p>
          <p>
            {t("reservation.detail.policyLateCancel", {
              percent: percentLabel(
                reservation.policy.lateCancellationRefundBp,
              ),
            })}
          </p>
          <p>
            {t("reservation.detail.policyNoShow", {
              percent: percentLabel(reservation.policy.noShowRefundBp),
            })}
          </p>
          {reservation.policy.minimumSpendIdr > 0 && (
            <p className="flex items-baseline justify-between gap-3">
              <span>{t("reservation.detail.policyMinimumSpendLabel")}</span>
              <Money
                amount={reservation.policy.minimumSpendIdr}
                size="sm"
                className="font-semibold text-foreground"
              />
            </p>
          )}
        </div>
      </section>

      <section className="grid gap-1.5">
        <h3 className="type-heading">
          {t("reservation.detail.preOrderTitle")}
        </h3>
        {preOrder ? (
          <div className="grid gap-1 rounded-container border-(length:--border-w) bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">
                {t("reservation.detail.preOrderPackage", {
                  name: preOrder.packageName,
                  pax: preOrder.pax,
                })}
              </p>
              <PreOrderStatusBadge status={preOrder.status} />
            </div>
            <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {t("reservation.detail.preOrderSubtotal")}
              </span>
              <Money
                amount={preOrder.subtotalIdr}
                size="sm"
                className="font-semibold"
              />
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("reservation.detail.noPreOrder")}
          </p>
        )}
        {actions.preOrder && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPreOrderOpen(true)}
            >
              {t(
                preOrder
                  ? "reservation.detail.actions.changePreOrder"
                  : "reservation.detail.actions.preOrder",
              )}
            </Button>
          </div>
        )}
      </section>

      {slots.length > 0 && (
        <section className="grid gap-1.5">
          <h3 className="type-heading">{t("reservation.detail.slotsTitle")}</h3>
          <ul className="grid list-none gap-1 p-0 text-sm text-muted-foreground">
            {slots.map((slot) => (
              <li
                key={slot.id}
                className="flex flex-wrap items-center gap-2 tabular"
              >
                <span className="font-semibold text-foreground">
                  {tableCodes.get(slot.tableId) ?? slot.tableId}
                </span>
                <span>
                  {t("reservation.detail.slotRange", {
                    start: formatClock(slot.startsAt, timeZone),
                    end: formatClock(slot.endsAt, timeZone),
                  })}
                </span>
                {slot.releasedAt && (
                  <Badge tone="neutral">
                    {t("reservation.detail.slotReleased")}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {actions.assign && reservation.tableIds.length === 0 && (
        <p className="text-sm text-warning">
          {t("reservation.detail.seatNeedsTable")}
        </p>
      )}
      {depositLink && (
        <section className="grid gap-1.5">
          <h3 className="type-heading">{t("reservation.depositLink.label")}</h3>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label={t("reservation.depositLink.label")}
              value={
                new URL(depositLink.paymentPath, window.location.origin).href
              }
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={copyDepositLink}>
              {t("reservation.depositLink.copy")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground tabular">
            {t("reservation.depositLink.expires", {
              time: formatClock(depositLink.expiresAt, timeZone),
            })}
          </p>
        </section>
      )}
      {resendError && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {resendError}
        </p>
      )}
      {seatError && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {seatError}
        </p>
      )}

      <DialogFooter className="flex-wrap">
        {actions.cancel && (
          <Button
            type="button"
            variant="ghost"
            className="text-danger"
            onClick={() => setCloseMode("cancel")}
          >
            {t("reservation.detail.actions.cancel")}
          </Button>
        )}
        {actions.noShow && (
          <Button
            type="button"
            variant="ghost"
            className="text-danger"
            onClick={() => setCloseMode("noShow")}
          >
            {t("reservation.detail.actions.noShow")}
          </Button>
        )}
        {canResendDeposit && (
          <Button
            type="button"
            variant="outline"
            loading={resend.isPending}
            onClick={resendDeposit}
          >
            {t("reservation.detail.actions.resendDeposit")}
          </Button>
        )}
        {actions.assign && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setAssignOpen(true)}
          >
            {t(
              reservation.tableIds.length > 0
                ? "reservation.detail.actions.reassign"
                : "reservation.detail.actions.assign",
            )}
          </Button>
        )}
        {actions.seat && (
          <Button type="button" loading={seat.isPending} onClick={seatNow}>
            {t("reservation.detail.actions.seat")}
          </Button>
        )}
      </DialogFooter>

      {assignOpen && (
        <AssignTablesDialog
          open
          onOpenChange={setAssignOpen}
          outletId={outletId}
          timeZone={timeZone}
          reservation={reservation}
        />
      )}
      {preOrderOpen && (
        <PreOrderDialog
          open
          onOpenChange={setPreOrderOpen}
          outletId={outletId}
          reservation={reservation}
        />
      )}
      {closeMode !== null && (
        <CloseReservationDialog
          open
          onOpenChange={(open) => !open && setCloseMode(null)}
          outletId={outletId}
          reservation={reservation}
          mode={closeMode}
        />
      )}
    </>
  );
}

export function ReservationDetailDialog({
  open,
  onOpenChange,
  outletId,
  timeZone,
  reservationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  timeZone: string;
  /** Deep-linkable: the dialog fetches the detail itself. */
  reservationId: string | null;
}) {
  const t = useT();
  const detail = useReservationDetail(outletId, reservationId ?? undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {detail.isPending ? (
          <div aria-busy="true" className="grid gap-3">
            <span className="sr-only" role="status">
              {t("reservation.detail.loading")}
            </span>
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-32 w-full rounded-container" />
          </div>
        ) : detail.error ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("reservation.detail.title")}</DialogTitle>
            </DialogHeader>
            <ErrorState
              error={detail.error}
              title={t("reservation.detail.errorTitle")}
              description={t("reservation.detail.errorHint")}
              onRetry={() => void detail.refetch()}
            />
          </>
        ) : (
          <DetailBody
            // Per-reservation state (the resent DP link, open dialogs) must not
            // carry over when the dialog shows another reservation.
            key={detail.data.reservation.id}
            outletId={outletId}
            timeZone={timeZone}
            reservation={detail.data.reservation}
            preOrder={detail.data.preOrder}
            slots={detail.data.tableSlots}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
