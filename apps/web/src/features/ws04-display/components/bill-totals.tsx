// Bill totals of the customer display. The amounts come from the terminal
// snapshot as-is (prices exclude tax and service charge; both are added at
// checkout — owner decision 12), so the screen never computes money itself.
import type { CustomerDisplayState } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { displayBalance, singleTenderMethod, TENDER_LABEL } from "../lib.ts";

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

/**
 * `unverified`: the payment status is unknown (code failed or expired), so the
 * remaining amount is labelled as "before the cashier's check".
 * `hideRemaining`: pay-at-cashier mode (DP order); no remaining-to-pay figure
 * is derived from the QRIS amount, only the bill total shows.
 */
export function BillTotals({
  state,
  unverified = false,
  hideRemaining = false,
}: {
  state: CustomerDisplayState;
  unverified?: boolean;
  hideRemaining?: boolean;
}) {
  const t = useT();
  const balance = displayBalance(
    hideRemaining ? { ...state, qris: null } : state,
  );
  const method = singleTenderMethod(state.tenders);
  const showBalance = balance.remainingIdr !== null;
  // A code with a guest fee shows a second figure ("Yang harus dibayar"), so
  // this one is the bill (K4 P2-1).
  const billLabelled = showBalance || Boolean(state.onlineCode?.guestFeeIdr);
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
          <dt className="type-title">
            {t(
              billLabelled
                ? "posDisplay.totals.billTotal"
                : "posDisplay.totals.total",
            )}
          </dt>
          <dd>
            <Money amount={state.totalIdr} size={showBalance ? "lg" : "hero"} />
          </dd>
        </div>
        {balance.depositIdr > 0 && (
          <TotalRow
            label={t("posDisplay.totals.deposit")}
            amount={-balance.depositIdr}
          />
        )}
        {balance.capturedIdr > 0 && (
          <TotalRow
            label={
              method
                ? t("posDisplay.totals.confirmed", {
                    method: t(TENDER_LABEL[method]),
                  })
                : t("posDisplay.totals.confirmedMixed")
            }
            amount={-balance.capturedIdr}
          />
        )}
      </dl>
      {balance.remainingIdr !== null && (
        <div className="grid gap-1 rounded-container bg-surface-2 p-4">
          <p className="text-(length:--density-text) leading-6">
            {t(
              state.state === "paid"
                ? "posDisplay.totals.remainingPaid"
                : unverified
                  ? "posDisplay.totals.unverified"
                  : "posDisplay.totals.remaining",
            )}
          </p>
          <Money amount={balance.remainingIdr} size="hero" />
        </div>
      )}
    </Card>
  );
}
