// DP breakdown. Every figure comes from the API (paid, forfeited, refund): the
// web never adds or subtracts money (brief "Aturan uang").
import { useId } from "react";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { guestHeading } from "./typography";

function Row({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-bold">
        <Money amount={amount} />
      </dd>
    </div>
  );
}

export function DepositBreakdown({
  paidIdr,
  forfeitedIdr,
  refundIdr,
  title,
  headingLevel = 2,
}: {
  paidIdr: number;
  forfeitedIdr: number | null;
  refundIdr: number | null;
  title?: string;
  /** h3 where the screen already has an h2 parent. */
  headingLevel?: 2 | 3;
}) {
  const t = useT();
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const heading = title ?? t("reservationGuest.deposit.title");
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-container border-(length:--border-w) bg-card p-6 shadow-hairline max-[760px]:p-5"
    >
      <Heading id={headingId} className={guestHeading}>
        {heading}
      </Heading>
      <dl className="mt-4 grid gap-3">
        <Row label={t("reservationGuest.deposit.paid")} amount={paidIdr} />
        {forfeitedIdr !== null && (
          <Row
            label={t("reservationGuest.deposit.forfeited")}
            amount={forfeitedIdr}
          />
        )}
        {refundIdr !== null && (
          <Row
            label={t("reservationGuest.deposit.refund")}
            amount={refundIdr}
          />
        )}
      </dl>
    </section>
  );
}
