// The server's quote, line by line (ORD-03). Menu prices exclude tax and
// service charge (owner rule), so both appear here before the total.
import type { OrderQuote } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
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
  // v3 double shell: one card for the quote, the "prices exclude tax and
  // service" note on the shell footer (owner rule 12).
  return (
    <CardShell role="group" aria-labelledby="breakdown-title">
      <CardShellBody>
        <div className="grid gap-3 px-card pt-card pb-2">
          <h2 id="breakdown-title" className="type-title">
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
            <div className="mt-1 flex items-baseline justify-between gap-3 border-t-(length:--border-w) pt-3">
              <dt className="type-heading">
                {t("qrCart.checkout.breakdown.total")}
              </dt>
              <dd>
                <Money amount={quote.totalIdr} size="stat" />
              </dd>
            </div>
          </dl>
        </div>
      </CardShellBody>
      <CardShellFooter>
        {t("qrCart.checkout.breakdown.excludedNote")}
      </CardShellFooter>
    </CardShell>
  );
}
