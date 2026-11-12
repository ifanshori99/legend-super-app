// Paid confirmation of the customer display: how the bill was paid and the
// change the cashier hands over. The tenders come from the terminal snapshot.
import { CircleCheck } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { CustomerDisplayState } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { displayBalance, singleTenderMethod, TENDER_LABEL } from "../lib.ts";

export function PaidPanel({ state }: { state: CustomerDisplayState }) {
  const t = useT();
  const change = state.changeIdr ?? 0;
  const { depositIdr, capturedIdr } = displayBalance(state);
  const method = singleTenderMethod(state.tenders);
  const methodLabel = method ? t(TENDER_LABEL[method]) : null;
  return (
    <Card>
      <div className="flex items-center gap-2">
        <CircleCheck className="size-5 text-success" aria-hidden="true" />
        <h2 className="type-title">{t("posDisplay.paid.confirmed")}</h2>
      </div>
      <p className="type-title">{t("posDisplay.paid.thanks")}</p>
      <p className="text-sm leading-5 text-muted-foreground">
        {methodLabel
          ? t("posDisplay.paid.receivedMethod", { method: methodLabel })
          : t("posDisplay.paid.received")}
      </p>
      {capturedIdr > 0 && <Money amount={capturedIdr} size="stat" />}
      {depositIdr > 0 && (
        // The deposit plus what was captured is the whole bill: the customer
        // sees that nothing was charged twice.
        <p className="text-sm leading-5 text-muted-foreground tabular">
          {t("posDisplay.paid.sum", {
            deposit: formatRupiah(depositIdr),
            method: methodLabel ?? t("posDisplay.paid.methodMixed"),
            captured: formatRupiah(capturedIdr),
            total: formatRupiah(state.totalIdr),
          })}
        </p>
      )}
      <div className="grid gap-2">
        <p className="type-eyebrow text-muted-foreground">
          {t("posDisplay.paid.tenders")}
        </p>
        <dl className="grid gap-1.5">
          {state.tenders.map((tender, index) => (
            <div
              key={`${tender.method}-${index}`}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="text-(length:--density-text) leading-6">
                {t(TENDER_LABEL[tender.method])}
              </dt>
              <dd>
                <Money amount={tender.amountIdr} className="font-semibold" />
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {change > 0 && (
        <div className="flex items-baseline justify-between gap-3 border-t-(length:--border-w) pt-3">
          <div className="min-w-0">
            <p className="type-title">{t("posDisplay.paid.change")}</p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("posDisplay.paid.changeHint")}
            </p>
          </div>
          <Money amount={change} size="stat" />
        </div>
      )}
    </Card>
  );
}
