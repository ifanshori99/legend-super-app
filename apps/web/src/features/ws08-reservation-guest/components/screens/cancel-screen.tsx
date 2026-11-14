// Guest cancel confirmation (legend-g12il): the free-cancel and the late
// (DP forfeited) variants, plus the submitting state. Every rupiah figure is
// read from the API (`cancellation.preview`); the web never computes money.
import { useEffect, useRef, useState } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import type {
  GuestCancelResult,
  GuestReservationView,
} from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { MAX_NOTE } from "@/features/ws08-reservation-customer/lib";
import { useCancelGuestReservation } from "../../hooks";
import { guestErrorKind } from "../../lib";
import { DepositBreakdown } from "../deposit-breakdown";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { ReservationSummary } from "../reservation-summary";
import { StatusPill } from "../status-pill";
import { guestBody, guestHint, guestTitle } from "../typography";
import { InvalidLinkScreen } from "./recovery-screens";
import { clockLabel, dayLabel, useFocusHeading } from "./screen-helpers";

/** Long day and outlet clock, e.g. { day: "Rabu, 18 November 2026", time: "19.00 WIB" }. */
export function instantParts(
  instant: string,
  timeZone: string,
): { day: string; time: string } {
  return {
    day: dayLabel(instant, timeZone),
    time: clockLabel(instant, timeZone),
  };
}

type CancelScreenProps = {
  view: GuestReservationView;
  timeZone: string;
  token: string;
  onBack: () => void;
  onCancelled: (result: GuestCancelResult) => void;
};

export function CancelScreen({
  view,
  timeZone,
  token,
  onBack,
  onCancelled,
}: CancelScreenProps) {
  const t = useT();
  const headingRef = useFocusHeading();
  const [reason, setReason] = useState("");
  const cancel = useCancelGuestReservation(token);
  const preview = view.cancellation.preview;
  const freeUntil = view.cancellation.freeUntil
    ? instantParts(view.cancellation.freeUntil, timeZone)
    : null;
  // legend-g12il: "late" means the server preview already forfeits some DP.
  const late = preview !== null && preview.forfeitedIdr > 0;
  const submitting = cancel.isPending;
  const errorKind = cancel.isError ? guestErrorKind(cancel.error) : null;

  // Move focus to the heading when a submit starts and when it fails, so the
  // guest hears the new state (skipped on first render: the heading already
  // takes focus on mount).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [headingRef, submitting, errorKind]);

  if (errorKind === "invalid") return <InvalidLinkScreen />;

  const submit = () => {
    const trimmed = reason.trim();
    cancel.mutate(trimmed ? { reason: trimmed } : {}, {
      onSuccess: (result: GuestCancelResult) => onCancelled(result),
    });
  };

  const errorText = (() => {
    switch (errorKind) {
      case null:
        return null;
      case "network":
        return t("reservationGuestCancel.cancel.errorNetwork");
      case "rate_limited":
        return t("reservationGuestCancel.cancel.errorRateLimited");
      case "transition":
        return t("reservationGuestCancel.cancel.errorTransition");
      default:
        return t("reservationGuestCancel.cancel.errorUnknown");
    }
  })();

  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="warning">
            {late
              ? t("reservationGuestCancel.cancel.pillLate")
              : t("reservationGuestCancel.cancel.pillFree")}
          </StatusPill>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`${guestTitle} outline-none`}
        >
          {t("reservationGuestCancel.cancel.title")}
        </h1>
        <p className={guestHint}>
          {late
            ? t("reservationGuestCancel.cancel.leadLate")
            : t("reservationGuestCancel.cancel.leadFree")}
        </p>
      </header>

      <ReservationSummary view={view} timeZone={timeZone} />

      {preview ? (
        <>
          <DepositBreakdown
            title={t("reservationGuestCancel.cancel.breakdownTitle")}
            paidIdr={view.deposit.paidIdr}
            forfeitedIdr={preview.forfeitedIdr}
            refundIdr={preview.refundIdr}
          />
          {preview.resolution === "nothing_paid" ? (
            <GuestNote
              tone="info"
              title={t("reservationGuestCancel.cancel.noteNothingPaidTitle")}
            >
              {t("reservationGuestCancel.cancel.noteNothingPaidBody")}
            </GuestNote>
          ) : late ? (
            <GuestNote
              tone="warning"
              title={t("reservationGuestCancel.cancel.noteLateTitle")}
            >
              {freeUntil
                ? t("reservationGuestCancel.cancel.noteLateBody", {
                    ...freeUntil,
                    forfeit: formatRupiah(preview.forfeitedIdr),
                  })
                : t("reservationGuestCancel.cancel.noteLateBodyNoDeadline", {
                    forfeit: formatRupiah(preview.forfeitedIdr),
                  })}
            </GuestNote>
          ) : (
            <GuestNote
              tone="info"
              title={t("reservationGuestCancel.cancel.noteFreeTitle")}
            >
              {freeUntil
                ? t("reservationGuestCancel.cancel.noteFreeBody", freeUntil)
                : t("reservationGuestCancel.cancel.noteFreeBodyNoDeadline")}
            </GuestNote>
          )}
        </>
      ) : (
        <GuestNote
          tone="warning"
          title={t("reservationGuestCancel.cancel.notAllowedTitle")}
        >
          {t("reservationGuestCancel.cancel.notAllowedBody")}
        </GuestNote>
      )}

      {preview && (
        <>
          <FormField
            className="[&_label]:text-base [&_label]:font-bold [&_label_span]:font-bold [&_label_span]:text-muted-foreground"
            label={t("reservationGuestCancel.cancel.reasonLabel")}
            hint={t("reservationGuestCancel.cancel.reasonHint", {
              max: MAX_NOTE,
            })}
          >
            <Textarea
              name="cancelReason"
              rows={3}
              maxLength={MAX_NOTE}
              value={reason}
              disabled={submitting}
              placeholder={t("reservationGuestCancel.cancel.reasonPlaceholder")}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <p className={guestBody}>
            {t("reservationGuestCancel.cancel.irreversible")}
          </p>
        </>
      )}

      {errorText && (
        <div role="alert">
          <GuestNote
            tone="warning"
            title={t("reservationGuestCancel.cancel.errorTitle")}
          >
            {errorText}
          </GuestNote>
        </div>
      )}

      <p role="status" className={submitting ? guestHint : "sr-only"}>
        {submitting ? t("reservationGuestCancel.cancel.submitting") : ""}
      </p>

      <GuestActions>
        {preview && (
          <Button
            type="button"
            className="h-auto min-h-12 w-full min-w-0 py-3 text-center text-balance whitespace-normal"
            loading={submitting}
            onClick={submit}
          >
            {submitting
              ? t("reservationGuestCancel.cancel.submitting")
              : late
                ? t("reservationGuestCancel.cancel.confirmLate", {
                    forfeit: formatRupiah(preview.forfeitedIdr),
                  })
                : t("reservationGuestCancel.cancel.confirmFree")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-12 w-full min-w-0 py-3 text-center text-balance whitespace-normal"
          disabled={submitting}
          onClick={onBack}
        >
          {preview
            ? t("reservationGuestCancel.cancel.keep")
            : t("reservationGuestCancel.cancel.back")}
        </Button>
      </GuestActions>
    </div>
  );
}
