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
import { guestBody, guestHeading, guestHint, guestTitle } from "../typography";
import { scheduleLabel, useFocusHeading } from "./screen-helpers";

export function DetailScreen({
  view,
  timeZone,
  late,
  onReschedule,
  onViewRequest,
  onCancel,
}: {
  view: GuestReservationView;
  timeZone: string;
  /** From `isLateForReschedule` (or a server late answer): no reschedule. */
  late: boolean;
  onReschedule: () => void;
  /** Back to the status of the pending request. */
  onViewRequest: () => void;
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
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`${guestTitle} outline-none`}
        >
          {t("reservationGuestRequest.detail.title")}
        </h1>
        <p className={guestHint}>
          {late || requestPending
            ? t("reservationGuestRequest.detail.leadLate")
            : t("reservationGuestRequest.detail.lead")}
        </p>
      </div>
      <ReservationSummary view={view} timeZone={timeZone} />
      {requestPending ? (
        <GuestNote
          tone="info"
          title={t("reservationGuestRequest.detail.pendingNoteTitle")}
        >
          {t("reservationGuestRequest.detail.pendingNoteBody")}
        </GuestNote>
      ) : (
        !late && (
          <GuestNote
            tone="info"
            title={t("reservationGuestRequest.detail.noteTitle")}
          >
            {t("reservationGuestRequest.detail.noteBody")}
          </GuestNote>
        )
      )}
      {showPolicy && (
        <section aria-labelledby="policy-heading" className="grid gap-2">
          <h2 id="policy-heading" className={guestHeading}>
            {t("reservationGuestRequest.detail.policyTitle")}
          </h2>
          {late ? (
            <p className={guestBody}>
              {t("reservationGuestRequest.detail.policyPassed")}
            </p>
          ) : (
            <>
              <p className={guestBody}>
                {t("reservationGuestRequest.detail.policyFree")}{" "}
                <strong>{scheduleLabel(t, freeUntil, timeZone)}</strong>.
              </p>
              <p className={guestHint}>
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
        {requestPending && (
          <Button type="button" variant="link" onClick={onViewRequest}>
            {t("reservationGuestRequest.detail.viewRequest")}
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
