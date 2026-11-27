import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { StatusPill } from "./status-pill";

export type BillPanelProps = {
  tableLabel: string;
  orderNo: string;
  itemCount: number;
  guestCount: number;
  subtotalIdr: number;
  serviceIdr: number;
  taxIdr: number;
  totalIdr: number;
  deposit?: { reference?: string; amountIdr: number; paid: boolean };
  /** Every payment on the bill; only the confirmed ones reduce the balance. */
  allocations: ReadonlyArray<{
    id: string;
    label: string;
    amountIdr: number;
    status: string;
  }>;
  remainingIdr: number;
  paid: boolean;
  /** Voucher already applied; the discount is priced by the server and total already includes it. */
  voucher?: { code: string; discountIdr: number } | null;
  onRemoveVoucher?: () => void;
  removingVoucher?: boolean;
  className?: string;
};

function Line({
  label,
  children,
  strong = false,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
}) {
  // One <dl> per line: the deposit notes between lines are plain paragraphs,
  // which a <dl> may not contain.
  return (
    <dl>
      <div
        className={cn(
          "flex items-baseline justify-between gap-3 text-(length:--density-text)",
          strong && "font-bold",
        )}
      >
        <dt>{label}</dt>
        <dd>{children}</dd>
      </div>
    </dl>
  );
}

// The bill on the left of every payment screen: table, status, totals, the
// deposit and payments already confirmed, and the balance still due in big
// figures. Presentational: the numbers come in as plain props.
export function BillPanel({
  tableLabel,
  orderNo,
  itemCount,
  guestCount,
  subtotalIdr,
  serviceIdr,
  taxIdr,
  totalIdr,
  deposit,
  allocations,
  remainingIdr,
  paid,
  voucher,
  onRemoveVoucher,
  removingVoucher = false,
  className,
}: BillPanelProps) {
  const t = useT();
  const confirmed = allocations.filter((a) => a.status === "confirmed");
  // Settled by the DP alone: the balance is a plain "Sisa tagihan" Rp 0.
  const settledByDeposit =
    paid && confirmed.length === 0 && deposit?.paid === true;
  return (
    <section
      data-slot="bill-panel"
      aria-label={tableLabel}
      className={cn(
        "flex h-full flex-col gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card",
        className,
      )}
    >
      <header className="grid gap-2 border-b-(length:--border-w) border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="type-title">{tableLabel}</h2>
          <span aria-live="polite">
            {paid ? (
              <StatusPill tone="success">
                {t("posKasirCommon.bill.paid")}
              </StatusPill>
            ) : (
              <StatusPill tone="warning">
                {t("posKasirCommon.bill.unpaid")}
              </StatusPill>
            )}
          </span>
        </div>
        <p className="tabular text-base text-muted-foreground">
          {t("posKasirCommon.bill.summary", {
            orderNo,
            items: itemCount,
            guests: guestCount,
          })}
        </p>
      </header>
      <div className="grid gap-2">
        <Line label={t("posKasirCommon.bill.subtotal")}>
          <Money amount={subtotalIdr} />
        </Line>
        <Line label={t("posKasirCommon.bill.service")}>
          <Money amount={serviceIdr} />
        </Line>
        <Line label={t("posKasirCommon.bill.tax")}>
          <Money amount={taxIdr} />
        </Line>
        {voucher && (
          <Line
            label={t("posKasirPayment.bill.voucher", { code: voucher.code })}
          >
            <Money amount={-voucher.discountIdr} className="font-semibold" />
          </Line>
        )}
        {voucher && onRemoveVoucher && !paid && (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-end"
            disabled={removingVoucher}
            aria-busy={removingVoucher}
            onClick={onRemoveVoucher}
          >
            {t(
              removingVoucher
                ? "posKasirPayment.bill.voucherRemoving"
                : "posKasirPayment.bill.voucherRemove",
            )}
          </Button>
        )}
        <Line label={t("posKasirCommon.bill.total")} strong>
          <Money amount={totalIdr} />
        </Line>
        {deposit?.paid && (
          <>
            <Line label={t("posKasirCommon.bill.depositUsed")}>
              <Money amount={-deposit.amountIdr} className="font-semibold" />
            </Line>
            <p className="tabular text-sm text-muted-foreground">
              {deposit.reference
                ? t("posKasirCommon.bill.depositPaid", {
                    reference: deposit.reference,
                  })
                : t("posKasirPayment.bill.depositPaidNoRef")}
            </p>
          </>
        )}
        {deposit && !deposit.paid && (
          <p className="tabular text-sm text-muted-foreground">
            {deposit.reference
              ? t("posKasirCommon.bill.depositUnpaid", {
                  reference: deposit.reference,
                })
              : t("posKasirPayment.bill.depositUnpaidNoRef")}
          </p>
        )}
        {confirmed.map((allocation) => (
          <Line
            key={allocation.id}
            label={t("posKasirCommon.bill.confirmed", {
              label: allocation.label,
            })}
          >
            <Money amount={-allocation.amountIdr} className="font-semibold" />
          </Line>
        ))}
      </div>
      <div
        data-slot="bill-remaining"
        className="mt-auto rounded-control bg-surface-3 p-4"
      >
        <p className="text-base text-muted-foreground">
          {t(
            paid && !settledByDeposit
              ? "posKasirCommon.bill.remainingPaid"
              : "posKasirCommon.bill.remaining",
          )}
        </p>
        <Money amount={remainingIdr} size="hero" />
      </div>
    </section>
  );
}
