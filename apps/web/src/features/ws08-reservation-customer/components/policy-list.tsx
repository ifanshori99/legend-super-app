// The policy snapshot a reservation carries, rendered from data only (RSV-03:
// "Pembatalan mengikuti kebijakan refund yang berlaku saat reservasi dibuat").
// Every number comes from `reservation.policy`; none is written into the
// catalog, so a later policy change can never change what this guest sees.
import { formatRupiah } from "@starter/shared/i18n";
import type { ReservationPolicySnapshot } from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { formatBasisPoints, formatInstant } from "../lib";

export function PolicyList({
  policy,
  timeZone,
}: {
  policy: ReservationPolicySnapshot;
  timeZone: string;
}) {
  const t = useT();
  const hasDeposit = policy.depositRequirement !== "none";
  return (
    <div className="grid gap-2">
      <p className="text-sm leading-5 font-semibold">
        {hasDeposit
          ? t("reservationBooking.policy.deposit", {
              amount: formatRupiah(policy.depositAmountIdr),
            })
          : t("reservationBooking.policy.noDeposit")}
      </p>
      <ul className="grid gap-1.5 text-sm leading-5 text-muted-foreground">
        <li>
          {t("reservationBooking.policy.freeCancel", {
            hours: policy.freeCancellationHours,
          })}
        </li>
        {hasDeposit && (
          <>
            <li>
              {t("reservationBooking.policy.lateCancel", {
                hours: policy.freeCancellationHours,
                percent: formatBasisPoints(policy.lateCancellationRefundBp),
              })}
            </li>
            <li>
              {t("reservationBooking.policy.noShow", {
                percent: formatBasisPoints(policy.noShowRefundBp),
              })}
            </li>
          </>
        )}
        {policy.minimumSpendIdr > 0 && (
          <li>
            {t("reservationBooking.policy.minimumSpend", {
              amount: formatRupiah(policy.minimumSpendIdr),
            })}
          </li>
        )}
      </ul>
      <p className="text-xs leading-4 text-muted-foreground">
        {t("reservationBooking.policy.version", {
          version: policy.version,
          time: formatInstant(policy.capturedAt, timeZone),
        })}
      </p>
    </div>
  );
}
