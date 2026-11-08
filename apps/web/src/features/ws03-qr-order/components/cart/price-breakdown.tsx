// The server's quote as plain rows (ORD-03): subtotal, discounts, service,
// tax, rounding. Menu prices exclude tax and service charge (owner rule), so
// both appear here; the grand total lives in the action footer.
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
    <section
      aria-labelledby="breakdown-title"
      className="border-y border-border py-3"
    >
      <h2 id="breakdown-title" className="sr-only">
        {t("qrGlass.checkout.breakdownTitle")}
      </h2>
      <dl className="grid gap-1 text-lg leading-7">
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
          label={t("qrGlass.checkout.service", {
            rate: quote.serviceCharge.rateBp / 100,
          })}
          amount={quote.serviceCharge.amountIdr}
        />
        {quote.taxLines.map((line) => (
          <Row
            key={line.taxRuleId}
            label={t("qrGlass.checkout.tax", {
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
      </dl>
    </section>
  );
}
