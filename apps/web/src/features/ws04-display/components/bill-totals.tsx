// Bill totals of the customer display. The amounts come from the terminal
// snapshot as-is (prices exclude tax and service charge; both are added at
// checkout — owner decision 12), so the screen never computes money itself.
import type { CustomerDisplayState } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";

function TotalRow({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm leading-5 text-muted-foreground">{label}</dt>
      <dd>
        <Money amount={amount} className="font-semibold" />
      </dd>
    </div>
  );
}

export function BillTotals({ state }: { state: CustomerDisplayState }) {
  const t = useT();
  return (
    <Card>
      <h2 className="type-title">{t("posDisplay.totals.label")}</h2>
      <dl className="grid gap-2">
        <TotalRow
          label={t("posDisplay.totals.subtotal")}
          amount={state.subtotalIdr}
        />
        {state.discountIdr > 0 && (
          <TotalRow
            label={t("posDisplay.totals.discount")}
            amount={-state.discountIdr}
          />
        )}
        <TotalRow
          label={t("posDisplay.totals.service")}
          amount={state.serviceChargeIdr}
        />
        <TotalRow label={t("posDisplay.totals.tax")} amount={state.taxIdr} />
        {state.roundingIdr !== 0 && (
          <TotalRow
            label={t("posDisplay.totals.rounding")}
            amount={state.roundingIdr}
          />
        )}
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t-(length:--border-w) pt-3">
          <dt className="type-title">{t("posDisplay.totals.total")}</dt>
          <dd>
            <Money amount={state.totalIdr} size="hero" />
          </dd>
        </div>
      </dl>
    </Card>
  );
}
