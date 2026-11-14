// Guest manage page: reservation detail (bead legend-g12il, state "detail").
// Every DP figure stays on the server; this screen only shows the policy
// deadline and offers the two actions. When the reschedule deadline has
// passed (`late`), a reschedule is refused, so only the calm cancel action
// remains and the policy text names no deadline figures.
import type { GuestReservationView } from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { ReservationSummary } from "../reservation-summary";
import { StatusPill } from "../status-pill";
import { scheduleLabel, useFocusHeading } from "./screen-helpers";

export function DetailScreen({
  view,
  timeZone,
  late,
  onReschedule,
  onCancel,
}: {
  view: GuestReservationView;
  timeZone: string;
  /** From `isLateForReschedule` (or a server late answer): no reschedule. */
  late: boolean;
  onReschedule: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const headingRef = useFocusHeading();
  // A pending request is explained on its own screen: no second ask.
  const requestPending = view.rescheduleRequest?.status === "pending";
  const awaitingDeposit = view.status === "pending_deposit";
  const { freeUntil } = view.cancellation;
  // The policy only moves DP money: without a paid DP there is nothing to show.
  const showPolicy = view.deposit.paidIdr > 0 && freeUntil !== null;
  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <StatusPill tone={awaitingDeposit ? "warning" : "success"}>
          {awaitingDeposit
            ? t("reservationGuestRequest.detail.pillPendingDeposit")
            : t("reservationGuestRequest.detail.pillConfirmed")}
        </StatusPill>
        <h1 ref={headingRef} tabIndex={-1} className="type-title outline-none">
          {t("reservationGuestRequest.detail.title")}
        </h1>
        <p className="text-muted-foreground">
          {late
            ? t("reservationGuestRequest.detail.leadLate")
            : t("reservationGuestRequest.detail.lead")}
        </p>
      </div>
      <ReservationSummary view={view} timeZone={timeZone} />
      {!late && (
        <GuestNote
          tone="info"
          title={t("reservationGuestRequest.detail.noteTitle")}
        >
          {t("reservationGuestRequest.detail.noteBody")}
        </GuestNote>
      )}
      {showPolicy && (
        <section aria-labelledby="policy-heading" className="grid gap-2">
          <h2 id="policy-heading" className="type-heading">
            {t("reservationGuestRequest.detail.policyTitle")}
          </h2>
          {late ? (
            <p>{t("reservationGuestRequest.detail.policyPassed")}</p>
          ) : (
            <>
              <p>
                {t("reservationGuestRequest.detail.policyFree", {
                  deadline: scheduleLabel(t, freeUntil, timeZone),
                })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("reservationGuestRequest.detail.policyLate")}
              </p>
            </>
          )}
        </section>
      )}
      <GuestActions>
        {!late && !requestPending && (
          <Button type="button" onClick={onReschedule}>
            {t("reservationGuestRequest.detail.reschedule")}
          </Button>
        )}
        {view.cancellation.allowed && (
          <Button
            type="button"
            variant={late ? "outline" : "link"}
            onClick={onCancel}
          >
            {t("reservationGuestRequest.detail.cancel")}
          </Button>
        )}
      </GuestActions>
    </div>
  );
}
