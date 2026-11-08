import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useOutletClock } from "@/lib/tenant-context";
import {
  AmountKeypad,
  Notice,
  PosPanel,
  StatusPill,
  TenderCard,
} from "../shared";
import { usePaymentSession } from "../../hooks";
import type { PaymentMethodCode } from "../../types";
import {
  confirmedAllocations,
  formatClock,
  nextSequence,
} from "./payment-helpers";
import type { PaymentPanelProps } from "./panel-types";

export type SplitPanelProps = PaymentPanelProps & {
  method: PaymentMethodCode;
  methodLabel: string;
  /** The amount entered goes on to the method's own panel. */
  onContinue: (amountIdr: number) => void;
};

// Combined payment: what already counts against the bill on the left, the
// amount for the next payment on the right (whole rupiah, touch keypad).
export function SplitPanel({
  orderId,
  amountIdr,
  method,
  methodLabel,
  onChangeMethod,
  onContinue,
}: SplitPanelProps) {
  const t = useT();
  const { clock } = useOutletClock();
  const { bill } = usePaymentSession(orderId);
  const [amount, setAmount] = useState(amountIdr);
  if (!bill) return null;

  const confirmed = confirmedAllocations(bill);
  const tooMuch = amount > bill.remainingIdr;
  const valid = amount > 0 && !tooMuch;
  const sequence = nextSequence(bill);
  const tenderCount = confirmed.length + (bill.deposit?.paid ? 1 : 0);
  const amountText = formatRupiah(amount);

  return (
    <PosPanel
      title={t("posKasirPayment.split.title")}
      aside={
        <StatusPill tone="neutral">
          {t("posKasirPayment.split.count", { count: tenderCount })}
        </StatusPill>
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onChangeMethod}>
            {t("posKasirPayment.split.changeMethod")}
          </Button>
          <Button
            type="button"
            disabled={!valid}
            onClick={() => onContinue(amount)}
          >
            {method === "cash"
              ? t("posKasirPayment.split.acceptCash", { amount: amountText })
              : t("posKasirPayment.split.continue", { method: methodLabel })}
            <ArrowRight aria-hidden="true" />
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          {bill.deposit?.paid && (
            <TenderCard
              title={t("posKasirPayment.split.deposit")}
              status={{
                tone: "success",
                label: t("posKasirPayment.split.depositUsed"),
              }}
              reference={bill.deposit.reference}
              amountIdr={bill.deposit.amountIdr}
            />
          )}
          {confirmed.map((allocation, index) => (
            <TenderCard
              key={allocation.id}
              title={allocation.label}
              status={{
                tone: "success",
                label: t("posKasirPayment.split.paidPill"),
              }}
              reference={t("posKasirPayment.split.sequence", {
                number: String(index + 1).padStart(2, "0"),
              })}
              amountIdr={allocation.amountIdr}
              note={
                allocation.confirmedAt
                  ? t("posKasirPayment.split.confirmedAt", {
                      time: formatClock(allocation.confirmedAt, clock.timeZone),
                    })
                  : undefined
              }
            />
          ))}
          <Notice
            tone="warning"
            title={t("posKasirPayment.split.short", {
              amount: formatRupiah(bill.remainingIdr),
            })}
          >
            {t("posKasirPayment.split.shortHint")}
          </Notice>
        </div>
        <div className="grid content-start gap-3">
          <AmountKeypad
            value={amount}
            onChange={setAmount}
            max={bill.remainingIdr}
            label={t("posKasirPayment.split.amountLabel", {
              number: sequence,
              method: methodLabel,
            })}
            hint={t("posKasirPayment.split.amountHint")}
          />
          <div aria-live="polite">
            {tooMuch && (
              <Notice
                tone="danger"
                title={t("posKasirPayment.split.tooMuch", {
                  amount: formatRupiah(bill.remainingIdr),
                })}
              />
            )}
          </div>
        </div>
      </div>
    </PosPanel>
  );
}
