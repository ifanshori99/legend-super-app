// Late state (legend-g12il, founder W3 Q13): a late reschedule is refused, so
// the guest keeps the original time or cancels with the DP forfeited. The
// figures come from `cancellation.preview`; the web never computes money.
import type { GuestReservationView } from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DepositBreakdown } from "../deposit-breakdown";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { ReservationSummary } from "../reservation-summary";
import { StatusPill } from "../status-pill";
import { guestBody, guestHeading, guestHint, guestTitle } from "../typography";
import { instantParts } from "./cancel-screen";
import { useFocusHeading } from "./screen-helpers";

type LateScreenProps = {
  view: GuestReservationView;
  timeZone: string;
  onKeep: () => void;
  onCancel: () => void;
};

export function LateScreen({
  view,
  timeZone,
  onKeep,
  onCancel,
}: LateScreenProps) {
  const t = useT();
  const headingRef = useFocusHeading();
  const preview = view.cancellation.preview;
  const freeUntil = view.cancellation.freeUntil
    ? instantParts(view.cancellation.freeUntil, timeZone)
    : null;
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="warning">
            {t("reservationGuestCancel.late.pill")}
          </StatusPill>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`${guestTitle} outline-none`}
        >
          {t("reservationGuestCancel.late.title")}
        </h1>
        <p className={guestHint}>{t("reservationGuestCancel.late.lead")}</p>
      </header>

      <GuestNote
        tone="warning"
        title={
          freeUntil
            ? t("reservationGuestCancel.late.noteTitle", {
                day: freeUntil.day,
              })
            : t("reservationGuestCancel.late.noteTitleNoDeadline")
        }
      >
        {freeUntil
          ? t("reservationGuestCancel.late.noteBody", {
              time: freeUntil.time,
            })
          : t("reservationGuestCancel.late.noteBodyNoDeadline")}
      </GuestNote>

      <ReservationSummary view={view} timeZone={timeZone} />

      {preview && (
        <section className="grid gap-3" aria-labelledby="late-cancellation">
          <h2 id="late-cancellation" className={guestHeading}>
            {t("reservationGuestCancel.late.cancelHeading")}
          </h2>
          <p className={guestBody}>
            {t("reservationGuestCancel.late.cancelBody")}
          </p>
          <DepositBreakdown
            headingLevel={3}
            paidIdr={view.deposit.paidIdr}
            forfeitedIdr={preview.forfeitedIdr}
            refundIdr={preview.refundIdr}
          />
          <p className={guestHint}>
            {t("reservationGuestCancel.late.cancelHint")}
          </p>
        </section>
      )}

      <GuestActions>
        <Button type="button" className="w-full" onClick={onKeep}>
          {t("reservationGuestCancel.late.keep")}
        </Button>
        {view.cancellation.allowed && (
          <Button
            type="button"
            variant="link"
            className="w-full"
            onClick={onCancel}
          >
            {t("reservationGuestCancel.late.review")}
          </Button>
        )}
      </GuestActions>
    </div>
  );
}
