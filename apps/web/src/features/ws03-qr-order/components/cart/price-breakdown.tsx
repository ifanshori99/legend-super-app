// The server's quote, line by line (ORD-03). Menu prices exclude tax and
// service charge (owner rule), so both appear here before the total.
import type { OrderQuote } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";

function Row({
  label,
  amount,
  negative = false,
}: {
  label: string;
  amount: number;
  negative?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money amount={negative ? -amount : amount} />
      </dd>
    </div>
  );
}

export function PriceBreakdown({ quote }: { quote: OrderQuote }) {
  const t = useT();
  return (
    <section aria-labelledby="breakdown-title" className="grid gap-3">
      <h2 id="breakdown-title" className="text-lg leading-7 font-semibold">
        {t("qrCart.checkout.breakdown.title")}
      </h2>
      <dl className="grid gap-2 text-(length:--density-text)">
        <Row
          label={t("qrCart.checkout.breakdown.subtotal")}
          amount={quote.subtotalIdr}
        />
        {quote.discountLines.map((line) => (
          <Row
            key={`${line.source}-${line.label}`}
            label={`${t("qrCart.checkout.breakdown.discount")} · ${line.label}`}
            amount={line.amountIdr}
            negative
          />
        ))}
        <Row
          label={t("qrCart.checkout.breakdown.service", {
            rate: quote.serviceCharge.rateBp / 100,
          })}
          amount={quote.serviceCharge.amountIdr}
        />
        {quote.taxLines.map((line) => (
          <Row
            key={line.taxRuleId}
            label={t("qrCart.checkout.breakdown.tax", {
              name: line.name,
              rate: line.rateBp / 100,
            })}
            amount={line.amountIdr}
          />
        ))}
        {quote.rounding.adjustmentIdr !== 0 && (
          <Row
            label={t("qrCart.checkout.breakdown.rounding")}
            amount={quote.rounding.adjustmentIdr}
          />
        )}
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t pt-3">
          <dt className="text-lg font-semibold">
            {t("qrCart.checkout.breakdown.total")}
          </dt>
          <dd>
            <Money amount={quote.totalIdr} size="xl" />
          </dd>
        </div>
      </dl>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("qrCart.checkout.breakdown.excludedNote")}
      </p>
    </section>
  );
}
