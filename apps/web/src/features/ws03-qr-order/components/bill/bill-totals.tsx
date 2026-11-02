// The bill in rows: every amount comes from the server bill (ORD-03). Menu
// prices exclude tax and service charge, so both appear here (owner rule).
import type { ReactNode } from "react";
import { cn } from "cn";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { SessionBill } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import {
  Card,
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { minimumSpendShortfall } from "../../domain.ts";

function Row({
  label,
  children,
  strong = false,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-2",
        strong && "type-heading",
      )}
    >
      <dt className={cn(!strong && "text-muted-foreground")}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function BillTotals({ bill }: { bill: SessionBill }) {
  const t = useT();
  const { totals } = bill;
  // v3 double shell (DESIGN.md §4): the totals are one card; the tax/service
  // note lives on the shell footer, not as a loose paragraph (owner rule 12:
  // menu prices exclude tax and service charge, both shown here).
  return (
    <CardShell role="group" aria-labelledby="bill-summary">
      <CardShellBody>
        <div className="flex items-baseline justify-between gap-3 px-card pt-card pb-2">
          <h2 id="bill-summary" className="type-title">
            {t("qrOrders.bill.summaryTitle")}
          </h2>
          <span className="text-sm text-muted-foreground">
            {t("qrOrders.bill.orderCount", { count: bill.orders.length })}
          </span>
        </div>
        <dl className="divide-y px-card pb-1">
          <Row label={t("qrOrders.bill.subtotal")}>
            <Money amount={totals.subtotalIdr} />
          </Row>
          {totals.discountIdr > 0 && (
            <Row label={t("qrOrders.bill.discount")}>
              <Money amount={-totals.discountIdr} />
            </Row>
          )}
          <Row label={t("qrOrders.bill.service")}>
            <Money amount={totals.serviceChargeIdr} />
          </Row>
          <Row label={t("qrOrders.bill.tax")}>
            <Money amount={totals.taxIdr} />
          </Row>
          {totals.roundingIdr !== 0 && (
            <Row label={t("qrOrders.bill.rounding")}>
              <Money amount={totals.roundingIdr} />
            </Row>
          )}
          <Row label={t("qrOrders.bill.total")} strong>
            <Money amount={totals.totalIdr} size="lg" />
          </Row>
          <Row label={t("qrOrders.bill.paid")}>
            <Money amount={totals.paidIdr} />
          </Row>
          <Row label={t("qrOrders.bill.outstanding")} strong>
            <Money amount={totals.outstandingIdr} size="lg" />
          </Row>
        </dl>
      </CardShellBody>
      <CardShellFooter>{t("qrOrders.bill.taxNote")}</CardShellFooter>
    </CardShell>
  );
}

/** PRD "Kontrol Open Bill" / flow B step 4: minimum spend status of the zone. */
export function MinimumSpendStatus({
  requiredIdr,
  bill,
}: {
  requiredIdr: number;
  bill: SessionBill;
}) {
  const t = useT();
  if (requiredIdr <= 0) return null;
  const shortfall = minimumSpendShortfall(
    requiredIdr,
    bill.totals.subtotalIdr,
    bill.totals.discountIdr,
  );
  const Icon = shortfall === 0 ? CircleCheck : TriangleAlert;
  return (
    <Card
      role="group"
      aria-labelledby="bill-min-spend"
      className="flex-row items-start gap-3"
    >
      <Icon
        className={cn(
          "mt-0.5 size-5 shrink-0",
          shortfall === 0 ? "text-success" : "text-warning",
        )}
        aria-hidden="true"
      />
      <div className="grid gap-0.5">
        <h2 id="bill-min-spend" className="type-title">
          {t("qrOrders.bill.minSpendTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {shortfall === 0
            ? t("qrOrders.bill.minSpendMet", {
                required: formatRupiah(requiredIdr),
              })
            : t("qrOrders.bill.minSpendShort", {
                shortfall: formatRupiah(shortfall),
                required: formatRupiah(requiredIdr),
              })}
        </p>
      </div>
    </Card>
  );
}
