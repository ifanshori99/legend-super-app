// The created split parts and the "pay my share" action (ORD-06: the parts add
// up exactly to the bill total, shown as a check line).
import { CircleCheck, Clock } from "lucide-react";
import type { BillSplit, SessionBill } from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";

export function liveSplits(bill: SessionBill): BillSplit[] {
  return bill.splits.filter((split) => split.status !== "voided");
}

export function SplitList({
  payPrimary = true,
  bill,
  participantIds,
  myParticipantId,
  onPay,
}: {
  /** False while the claim bar holds the one primary action of the page. */
  payPrimary?: boolean;
  bill: SessionBill;
  participantIds: readonly string[];
  myParticipantId: string | null;
  onPay: (split: BillSplit) => void;
}) {
  const t = useT();
  const splits = liveSplits(bill);
  const sum = splits.reduce((total, split) => total + split.amountIdr, 0);
  // Shares of one order (pay-first) add up to that order, else to the bill.
  const orderId = splits[0]?.orderId ?? null;
  const splitOrder =
    orderId !== null && splits.every((split) => split.orderId === orderId)
      ? bill.orders.find((order) => order.id === orderId)
      : undefined;
  const expected = splitOrder?.totalIdr ?? bill.totals.totalIdr;
  // One rust action: the first share the guest pays; the rest are outline.
  const firstPayable = splits.find(
    (split) =>
      split.status === "pending" &&
      (split.participantId === null || split.participantId === myParticipantId),
  );
  const guestName = (participantId: string) => {
    const n = participantIds.indexOf(participantId) + 1;
    return participantId === myParticipantId
      ? t("qrOrders.bill.guestYou", { n })
      : t("qrOrders.bill.guest", { n });
  };
  return (
    <section aria-labelledby="bill-shares" className="grid gap-3">
      <h2 id="bill-shares" className="type-title">
        {t("qrOrders.bill.listTitle")}
      </h2>
      <ul className="qr-paper divide-y divide-border">
        {splits.map((split) => {
          const mine =
            split.participantId === null ||
            split.participantId === myParticipantId;
          const name = split.participantId
            ? guestName(split.participantId)
            : (split.label ??
              t("qrOrders.bill.part", { n: split.shareIndex + 1 }));
          return (
            <li key={split.id} className="grid gap-3 p-card">
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-semibold">{name}</span>
                  <Money amount={split.amountIdr} size="lg" />
                </div>
                {split.status === "paid" ? (
                  <StatusPill status="success">
                    {t("qrOrders.bill.sharePaid")}
                  </StatusPill>
                ) : (
                  <StatusPill status="warning" icon={Clock}>
                    {t("qrOrders.bill.sharePending")}
                  </StatusPill>
                )}
              </div>
              {split.status === "pending" &&
                (mine ? (
                  <Button
                    type="button"
                    variant={
                      payPrimary && split === firstPayable
                        ? "default"
                        : "outline"
                    }
                    onClick={() => onPay(split)}
                  >
                    {t("qrOrders.bill.payShare")}
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("qrOrders.bill.shareWaiting", {
                      guest: guestName(split.participantId as string),
                    })}
                  </p>
                ))}
            </li>
          );
        })}
      </ul>
      {sum === expected && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <CircleCheck
            className="mt-0.5 size-4 shrink-0 text-success"
            aria-hidden="true"
          />
          {t("qrOrders.bill.splitSumOk", { amount: formatRupiah(sum) })}
        </p>
      )}
    </section>
  );
}
