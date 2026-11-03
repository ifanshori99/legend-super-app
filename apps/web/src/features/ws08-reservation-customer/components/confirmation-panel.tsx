// The guest's confirmation (PRD v1.7 §4 Alur H steps 3–4, RSV-02/RSV-03): the
// reservation as booked, the frozen policy snapshot shown back to the guest,
// and — when the snapshot requires a DP — the payment link card.
//
// The DP link is the contract's app-local path (`/bayar/<token>`); the page
// takes the token out of it instead of building a payment URL, so a gateway
// change never needs a code change here (WS-05 owns that page).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, Clock, TriangleAlert } from "lucide-react";
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
  // RSV-02: only a `confirmed` booking is shown as confirmed; anything else
  // still waits for its DP.
  const waitingForDeposit = reservation.status !== "confirmed";
  const token = deposit ? depositToken(deposit.paymentPath) : null;
  // The clock is browser-only (SSR and hydration must agree), so expiry is
  // known only after mount. A restored confirmation whose DP window passed no
  // longer offers a dead payment link.
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock is browser-only; reading it after mount keeps SSR and hydration identical.
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const depositExpired =
    waitingForDeposit &&
    deposit !== null &&
    nowMs !== null &&
    nowMs >= Date.parse(deposit.expiresAt);
  // Move focus to the result so keyboard and screen-reader users hear it
  // after the form is replaced.
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    heading.current?.focus();
  }, []);
  const zone = zoneName(reservation.zoneId);
  const businessDate = businessDateOfInstant(reservation.reservedFor, timeZone);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <h2
              ref={heading}
              tabIndex={-1}
              className="type-display-xl outline-none"
            >
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

          <div className="grid gap-1.5">
            <Badge
              tone={
                depositExpired
                  ? "danger"
                  : waitingForDeposit
                    ? "warning"
                    : "success"
              }
              className="w-fit"
            >
              {depositExpired ? (
                <TriangleAlert aria-hidden="true" />
              ) : waitingForDeposit ? (
                <Clock aria-hidden="true" />
              ) : (
                <CircleCheck aria-hidden="true" />
              )}
              {depositExpired
                ? t("reservationBooking.confirmation.expiredStatus")
                : waitingForDeposit
                  ? t("reservationBooking.confirmation.pendingStatus")
                  : t("reservationBooking.confirmation.confirmedStatus")}
            </Badge>
            {waitingForDeposit && !depositExpired && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.confirmation.statusSnapshot")}
              </p>
            )}
          </div>

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
              {depositExpired ? (
                <div
                  role="status"
                  className="grid gap-0.5 rounded-field bg-danger-subtle px-3 py-2"
                >
                  <p className="text-sm leading-5 font-semibold">
                    {t("reservationBooking.confirmation.expiredTitle")}
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("reservationBooking.confirmation.expiredHint")}
                  </p>
                </div>
              ) : !waitingForDeposit ? null : token ? (
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
