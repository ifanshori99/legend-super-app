// The guest's confirmation (PRD v1.7 §4 Alur H steps 3–4, RSV-02/RSV-03): the
// reservation as booked, the frozen policy snapshot shown back to the guest,
// and — when the snapshot requires a DP — the payment link card.
//
// The DP link is the contract's app-local path (`/bayar/<token>`); the page
// takes the token out of it instead of building a payment URL, so a gateway
// change never needs a code change here (WS-05 owns that page).
import { Link } from "@tanstack/react-router";
import { CircleCheck, Clock } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { ReservationCreated } from "@starter/shared/reservation";
import type { PublicSite } from "@starter/shared/website";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import { useT } from "@/components/i18n";
import {
  businessDateOfInstant,
  depositToken,
  formatClock,
  formatDayLabel,
  formatInstant,
} from "../lib";
import { zoneName } from "../zones";
import { PolicyList } from "./policy-list";

export function ConfirmationPanel({
  site,
  created,
  onNew,
}: {
  site: PublicSite;
  created: ReservationCreated;
  onNew: () => void;
}) {
  const t = useT();
  const timeZone = site.outlet.timeZone;
  const { reservation, deposit } = created;
  const waitingForDeposit = reservation.status === "pending_deposit";
  const token = deposit ? depositToken(deposit.paymentPath) : null;
  const zone = zoneName(reservation.zoneId);
  const businessDate = businessDateOfInstant(reservation.reservedFor, timeZone);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <h2 className="type-display-xl">
              {waitingForDeposit
                ? t("reservationBooking.confirmation.title")
                : t("reservationBooking.confirmation.titleConfirmed")}
            </h2>
            <p className="text-base leading-6 text-muted-foreground">
              {waitingForDeposit
                ? t("reservationBooking.confirmation.pendingLead")
                : t("reservationBooking.confirmation.confirmedLead")}
            </p>
          </div>

          <Badge tone={waitingForDeposit ? "warning" : "success"}>
            {waitingForDeposit ? (
              <Clock aria-hidden="true" />
            ) : (
              <CircleCheck aria-hidden="true" />
            )}
            {waitingForDeposit
              ? t("reservationBooking.confirmation.pendingStatus")
              : t("reservationBooking.confirmation.confirmedStatus")}
          </Badge>

          <div className="grid gap-1 border-t-(length:--border-w) pt-4">
            <p className="text-base leading-6 font-semibold">
              {t("reservationBooking.confirmation.guest", {
                name: reservation.guestName,
              })}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("reservationBooking.confirmation.when", {
                date: formatDayLabel(businessDate),
                time: formatClock(reservation.reservedFor, timeZone),
                pax: reservation.pax,
              })}
            </p>
            {zone && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.confirmation.zone", { zone })}
              </p>
            )}
            {reservation.note && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.confirmation.note", {
                  note: reservation.note,
                })}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid content-start gap-4">
        {deposit && (
          <Card>
            <CardContent className="grid gap-3">
              <div className="grid gap-1">
                <CardTitle>
                  {t("reservationBooking.confirmation.depositTitle", {
                    amount: formatRupiah(deposit.amountIdr),
                  })}
                </CardTitle>
                <CardDescription>
                  {t("reservationBooking.confirmation.depositExpires", {
                    time: formatInstant(deposit.expiresAt, timeZone),
                  })}
                </CardDescription>
              </div>
              {token ? (
                <Button asChild size="lg">
                  <Link to="/bayar/$token" params={{ token }}>
                    {t("reservationBooking.confirmation.depositAction")}
                  </Link>
                </Button>
              ) : (
                <Button size="lg" disabled>
                  {t("reservationBooking.confirmation.depositAction")}
                </Button>
              )}
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.confirmation.depositWindow", {
                  minutes: reservation.policy.paymentWindowMinutes,
                })}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.confirmation.depositHint")}
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="grid gap-3">
            <div className="grid gap-1">
              <CardTitle>{t("reservationBooking.policy.title")}</CardTitle>
              <CardDescription>
                {t("reservationBooking.policy.hint")}
              </CardDescription>
            </div>
            <PolicyList policy={reservation.policy} timeZone={timeZone} />
          </CardContent>
        </Card>

        <Button variant="outline" size="lg" onClick={onNew}>
          {t("reservationBooking.submit.newBooking")}
        </Button>
      </div>
    </div>
  );
}
