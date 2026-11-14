// Reservation card: outlet, the booked day and clock in the outlet's zone,
// party size and the DP already paid (an API figure, never computed here).
import { Store } from "lucide-react";
import type { GuestReservationView } from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import {
  businessDateOfInstant,
  formatClock,
  formatDayLabel,
} from "../../ws08-reservation-customer/lib.ts";
import { zoneLabel } from "../lib.ts";

const MONTH = new Intl.DateTimeFormat("id-ID", {
  timeZone: "UTC",
  month: "short",
});

export function ReservationSummary({
  view,
  timeZone,
}: {
  view: GuestReservationView;
  timeZone: string;
}) {
  const t = useT();
  const date = businessDateOfInstant(view.reservedFor, timeZone);
  const month = MONTH.format(new Date(`${date}T12:00:00.000Z`));
  const day = Number(date.slice(8, 10));
  return (
    <section
      aria-label={t("reservationGuest.summary.label")}
      className="rounded-container border-(length:--border-w) bg-card p-6 shadow-hairline max-[760px]:p-5"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-[12px] border-(length:--border-w) border-input text-primary"
        >
          <Store className="size-5" />
        </span>
        <strong className="min-w-0 text-base">{view.outletName}</strong>
      </div>
      <div className="mt-5 flex items-center gap-5 max-[760px]:gap-4">
        <div
          aria-hidden="true"
          className="w-16 shrink-0 overflow-hidden rounded-lg border-(length:--border-w) border-border text-center"
        >
          <span className="block bg-primary-tint py-0.5 text-xs font-bold tracking-wider text-primary uppercase">
            {month}
          </span>
          <b className="block py-1 text-2xl tabular">{day}</b>
        </div>
        <div className="min-w-0">
          <p className="text-lg font-bold max-[760px]:text-[17px]">
            {formatDayLabel(date)}
          </p>
          <p className="text-sm text-muted-foreground tabular">
            {t("reservationGuest.summary.time", {
              time: formatClock(view.reservedFor, timeZone),
              zone: zoneLabel(timeZone),
            })}
          </p>
        </div>
      </div>
      <dl className="mt-5 grid gap-3 border-t border-border pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">
            {t("reservationGuest.summary.guests")}
          </dt>
          <dd className="font-bold">
            {t("reservationGuest.summary.guestsValue", {
              count: view.partySize,
            })}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">
            {t("reservationGuest.summary.deposit")}
          </dt>
          <dd className="font-bold">
            <Money amount={view.deposit.paidIdr} />
          </dd>
        </div>
      </dl>
    </section>
  );
}
