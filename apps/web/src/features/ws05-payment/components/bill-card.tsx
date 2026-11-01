// The bill the guest is paying: reference, table context and the totals split
// (subtotal, discount, service charge, tax, rounding). Line items stay on the
// order screen; this is the amount the payment service priced (PAY-01).
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import type { CustomerPaymentBill } from "@starter/shared/payment";
import { billHasAddedCharges } from "../status";

function AmountRow({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money amount={amount} size="sm" />
      </dd>
    </div>
  );
}

export function BillCard({ bill }: { bill: CustomerPaymentBill }) {
  const t = useT();
  const totals = bill.totals;
  const tableContext =
    bill.tableLabel !== null && bill.pax !== null
      ? t("payment.tableContext", {
          table: `${t("terms.table")} ${bill.tableLabel}`,
          pax: bill.pax,
        })
      : null;

  return (
    <Card>
      <div className="grid gap-1">
        <h2 className="text-lg leading-7 font-semibold">
          {t("payment.billTitle")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payment.reference", { reference: bill.reference })}
        </p>
        {tableContext && (
          <p className="text-sm leading-5 font-medium">{tableContext}</p>
        )}
      </div>

      <dl className="grid gap-1.5 text-sm">
        <AmountRow label={t("payment.subtotal")} amount={totals.subtotalIdr} />
        {totals.discountIdr > 0 && (
          <AmountRow
            label={t("payment.discount")}
            amount={-totals.discountIdr}
          />
        )}
        {totals.serviceChargeIdr > 0 && (
          <AmountRow
            label={t("payment.serviceCharge")}
            amount={totals.serviceChargeIdr}
          />
        )}
        {totals.taxIdr > 0 && (
          <AmountRow label={t("payment.tax")} amount={totals.taxIdr} />
        )}
        {totals.roundingIdr !== 0 && (
          <AmountRow
            label={t("payment.rounding")}
            amount={totals.roundingIdr}
          />
        )}
      </dl>

      {billHasAddedCharges(totals) && (
        <p className="text-xs leading-5 text-muted-foreground">
          {t("payment.taxExclusiveHint")}
        </p>
      )}

      <div className="grid gap-1.5 border-t-(length:--border-w) border-border pt-3">
        {totals.paidIdr > 0 && (
          <dl className="grid gap-1.5 text-sm">
            <AmountRow label={t("payment.total")} amount={totals.totalIdr} />
            <AmountRow label={t("payment.paid")} amount={totals.paidIdr} />
          </dl>
        )}
        {/* A fully settled bill drops the redundant "Sisa tagihan Rp 0" row. */}
        {(totals.paidIdr === 0 || totals.outstandingIdr > 0) && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold">
              {totals.paidIdr > 0
                ? t("payment.outstanding")
                : t("payment.total")}
            </span>
            <Money amount={totals.outstandingIdr} size="lg" />
          </div>
        )}
      </div>
    </Card>
  );
}
