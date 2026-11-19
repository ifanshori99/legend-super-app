import type { ReactNode } from "react";
import type { MemberOpenBill } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";

// The bill the member is about to spend points on: outlet, bill number, and
// what is still owed. The member checks this against the cashier's screen
// before choosing points, so every amount comes straight from the server.
// A plain bordered block, not a Card, because it sits inside a panel.
export function BillCard({ bill }: { bill: MemberOpenBill }) {
  const t = useT();
  const idLine =
    bill.tableLabel === null
      ? t("member.tukarPoin.bill.idLineNoTable", { number: bill.billNumber })
      : t("member.tukarPoin.bill.idLine", {
          number: bill.billNumber,
          table: bill.tableLabel,
        });
  return (
    <section className="grid gap-4 rounded-container border-(length:--border-w) border-border bg-card p-4 md:p-5">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-brand type-heading min-w-0">{bill.outletName}</h3>
          <Badge tone="neutral">{t("member.tukarPoin.bill.connected")}</Badge>
        </div>
        {bill.outletArea !== null && (
          <p className="text-sm">{bill.outletArea}</p>
        )}
        <p className="text-sm leading-5 text-muted-foreground">{idLine}</p>
      </div>
      <dl className="grid gap-3 text-sm leading-5">
        <BillRow label={t("member.tukarPoin.bill.total")}>
          <Money amount={bill.totalIdr} size="sm" />
        </BillRow>
        <BillRow label={t("member.tukarPoin.bill.paid")}>
          <Money amount={bill.paidIdr} size="sm" />
        </BillRow>
        <BillRow label={t("member.tukarPoin.bill.remaining")} strong>
          <Money amount={bill.remainingIdr} size="sm" className="font-bold" />
        </BillRow>
      </dl>
    </section>
  );
}

function BillRow({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        strong
          ? "flex items-baseline justify-between gap-3 border-t-(length:--border-w) border-border pt-3 font-bold"
          : "flex items-baseline justify-between gap-3"
      }
    >
      <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
