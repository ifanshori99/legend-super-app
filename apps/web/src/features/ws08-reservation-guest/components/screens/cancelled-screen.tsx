// Cancelled state (legend-g12il). Shows what the server recorded for the DP
// (`view.deposit`); the web only compares amounts, never adds or subtracts.
// A cancelled booking does not mean the refund has landed, so the screen
// says so and offers a status re-check.
import { useState } from "react";
import type { GuestReservationView } from "@starter/shared/reservation";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useGuestReservation, useLinkToken } from "../../hooks";
import { DepositBreakdown } from "../deposit-breakdown";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { StatusPill } from "../status-pill";
import { guestHint, guestTitle } from "../typography";
import { instantParts } from "./cancel-screen";
import { clockLabel, useFocusHeading } from "./screen-helpers";

type CancelledScreenProps = {
  view: GuestReservationView;
  timeZone: string;
};

export function CancelledScreen({ view, timeZone }: CancelledScreenProps) {
  const t = useT();
  const headingRef = useFocusHeading();
  const token = useLinkToken();
  const reservation = useGuestReservation(token);
  const [checked, setChecked] = useState<
    "updated" | "unchanged" | "error" | null
  >(null);
  const [checkedAt, setCheckedAt] = useState("");
  const when = instantParts(view.reservedFor, timeZone);
  const { paidIdr, refundIdr, forfeitedIdr } = view.deposit;
  // Null refund or forfeit means the server has not recorded an outcome:
  // show nothing rather than a made-up zero.
  const outcome =
    paidIdr > 0 && refundIdr !== null && forfeitedIdr !== null
      ? { refundIdr, forfeitedIdr }
      : null;
  const checkRefund = async () => {
    const before = reservation.data;
    const result = await reservation.refetch();
    if (result.isError) {
      setChecked("error");
      return;
    }
    // Query structural sharing keeps the same object when nothing changed.
    setChecked(result.data === before ? "unchanged" : "updated");
    setCheckedAt(
      clockLabel(new Date(result.dataUpdatedAt).toISOString(), timeZone),
    );
  };
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="neutral">
            {t("reservationGuestCancel.cancelled.pill")}
          </StatusPill>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`${guestTitle} outline-none`}
        >
          {t("reservationGuestCancel.cancelled.title")}
        </h1>
        <p className={guestHint}>
          {t("reservationGuestCancel.cancelled.lead", {
            ...when,
            party: view.partySize,
          })}
        </p>
        <p className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          {view.outletName}
        </p>
      </header>

      {outcome && (
        <>
          <DepositBreakdown
            title={t("reservationGuestCancel.cancelled.breakdownTitle")}
            paidIdr={paidIdr}
            forfeitedIdr={outcome.forfeitedIdr}
            refundIdr={outcome.refundIdr}
          />
          {outcome.refundIdr > 0 ? (
            <GuestNote
              tone="info"
              title={t("reservationGuestCancel.cancelled.refundPendingTitle")}
            >
              {outcome.forfeitedIdr > 0
                ? t("reservationGuestCancel.cancelled.refundAndForfeitBody", {
                    refund: formatRupiah(outcome.refundIdr),
                    forfeit: formatRupiah(outcome.forfeitedIdr),
                  })
                : t("reservationGuestCancel.cancelled.refundOnlyBody", {
                    refund: formatRupiah(outcome.refundIdr),
                  })}
            </GuestNote>
          ) : (
            <GuestNote
              tone="info"
              title={t("reservationGuestCancel.cancelled.forfeitOnlyTitle")}
            >
              {t("reservationGuestCancel.cancelled.forfeitOnlyBody", {
                forfeit: formatRupiah(outcome.forfeitedIdr),
              })}
            </GuestNote>
          )}
        </>
      )}

      <p className={guestHint}>{t("reservationGuestCancel.cancelled.help")}</p>

      {outcome && outcome.refundIdr > 0 && (
        <GuestActions>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={reservation.isFetching}
            onClick={() => void checkRefund()}
          >
            {t("reservationGuestCancel.cancelled.checkRefund")}
          </Button>
          <p
            role={checked === "error" ? "alert" : "status"}
            className={checked ? `${guestHint} text-center` : "sr-only"}
          >
            {checked === "updated"
              ? t("reservationGuestCancel.cancelled.refundChecked", {
                  time: checkedAt,
                })
              : checked === "unchanged"
                ? t("reservationGuestCancel.cancelled.refundUnchanged")
                : checked === "error"
                  ? t("reservationGuestCancel.cancelled.refundCheckError")
                  : ""}
          </p>
        </GuestActions>
      )}
    </div>
  );
}
