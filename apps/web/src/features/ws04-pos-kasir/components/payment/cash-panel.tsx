import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { AmountKeypad, Notice, PosPanel, StatusPill } from "../shared";
import { useConfirmCash, usePaymentSession } from "../../hooks";
import { nextSequence, roundUpIdr } from "./payment-helpers";
import type { PaymentPanelProps } from "./panel-types";

// Cash: the cashier keys what the customer handed over, sees the change, and
// confirms. Nothing counts as paid until the confirmation is accepted; the
// payment session then flips to paid and the screen shows the success panel.
export function CashPanel({
  orderId,
  amountIdr,
  onChangeMethod,
}: PaymentPanelProps) {
  const t = useT();
  const { bill } = usePaymentSession(orderId);
  const confirm = useConfirmCash();
  const [received, setReceived] = useState(amountIdr);

  const short = received < amountIdr;
  const overRemaining = bill !== undefined && amountIdr > bill.remainingIdr;
  const change = Math.max(0, received - amountIdr);
  const sequence = bill ? nextSequence(bill) : "01";
  const roundUp = roundUpIdr(amountIdr);
  const quick = roundUp > amountIdr ? [amountIdr, roundUp] : [amountIdr];

  return (
    <PosPanel
      title={t("posKasirPayment.cash.title")}
      aside={
        <StatusPill tone="neutral">
          {t("posKasirPayment.cash.sequence", { number: sequence })}
        </StatusPill>
      }
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={confirm.isPending}
            onClick={onChangeMethod}
          >
            {t("posKasirPayment.cash.changeAmount")}
          </Button>
          <Button
            type="button"
            disabled={
              short || overRemaining || amountIdr <= 0 || confirm.isPending
            }
            aria-busy={confirm.isPending}
            onClick={() =>
              confirm.mutate({ orderId, amountIdr, receivedIdr: received })
            }
          >
            {confirm.isPending
              ? t("posKasirPayment.cash.confirming")
              : t("posKasirPayment.cash.confirm")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <AmountKeypad
          value={received}
          onChange={setReceived}
          label={t("posKasirPayment.cash.receivedLabel")}
          quickAmounts={quick}
        />
        <div className="grid content-start gap-3">
          <div className="rounded-container border-(length:--border-w) border-border bg-card p-4">
            <p className="text-(length:--density-text) text-muted-foreground">
              {t("posKasirPayment.cash.remaining")}
            </p>
            <Money amount={amountIdr} size="stat" />
          </div>
          <div
            aria-live="polite"
            className="rounded-container border-(length:--border-w) border-border bg-surface-3 p-4"
          >
            <p className="text-(length:--density-text)">
              {t("posKasirPayment.cash.change")}
            </p>
            <Money amount={change} size="hero" />
          </div>
          {short ? (
            <Notice
              tone="warning"
              title={t("posKasirPayment.cash.notEnough", {
                amount: formatRupiah(amountIdr - received),
              })}
            />
          ) : (
            <p className="text-base text-muted-foreground">
              {t("posKasirPayment.cash.note", {
                amount: formatRupiah(amountIdr),
              })}
            </p>
          )}
          {confirm.isError && (
            <Notice tone="danger" title={t("posKasirPayment.cash.failedTitle")}>
              {confirm.error.message} {t("posKasirPayment.cash.failedHint")}
            </Notice>
          )}
        </div>
      </div>
    </PosPanel>
  );
}
