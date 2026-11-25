import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";
import { ORDER_COMPLETE_FAILED } from "../../api";
import { usePaymentSession, usePrintReceipt } from "../../hooks";
import { useOrderTickets } from "../../ticket/hooks";
import { confirmedAllocations } from "./payment-helpers";
import { PaidTicketCard } from "./paid-ticket-card";
import type { PaymentPanelProps } from "./panel-types";
import { ReceiptNotPrinted, wasQueued } from "./receipt-result-notice";

function Row({ label, amountIdr }: { label: string; amountIdr: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
      <dt>{label}</dt>
      <dd>
        <Money amount={amountIdr} className="font-bold" />
      </dd>
    </div>
  );
}

// The bill is paid: hand over the change, show what made up the payment, print
// the receipt. Cash received and change come from the session, not from
// anything the cashier typed earlier.
export function SuccessPanel({ orderId }: PaymentPanelProps) {
  const t = useT();
  const navigate = useNavigate();
  const { bill, cash, receiptNo, completion } = usePaymentSession(orderId);
  const print = usePrintReceipt();
  // Same query as the ticket card (shared cache): with a ticket ready, issuing
  // it is the one primary action and the footer print button steps back.
  const tickets = useOrderTickets(orderId);
  const hasIssuedTicket = (tickets.data ?? []).some(
    (line) => line.lineStatus === "issued",
  );
  if (!bill) return null;

  const confirmed = confirmedAllocations(bill);
  const change = cash?.changeIdr ?? 0;
  const printedNo = print.data?.receiptNo ?? receiptNo;
  const notPrinted =
    print.data && !wasQueued(print.data) ? print.data : undefined;
  const held = completion === "held";
  const toNewTransaction = () => void navigate({ to: "/pos/meja" });

  return (
    <PosPanel
      title={t("posKasirPayment.success.title")}
      aside={
        <StatusPill tone="success">
          {t("posKasirPayment.success.paidPill")}
        </StatusPill>
      }
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate({ to: "/pos/customer-display" })}
          >
            {t("posKasirPayment.success.eReceipt")}
          </Button>
          <Button
            type="button"
            variant={hasIssuedTicket ? "outline" : "default"}
            disabled={print.isPending || held}
            aria-busy={print.isPending}
            onClick={() =>
              print.mutate(
                { orderId },
                {
                  onSuccess: (result) => {
                    if (wasQueued(result)) toNewTransaction();
                  },
                },
              )
            }
          >
            {print.isPending
              ? t("posKasirPayment.success.printing")
              : t("posKasirPayment.success.printAndNew")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </>
      }
    >
      <StateBlock
        mark="ok"
        title={
          change > 0
            ? t("posKasirPayment.success.change", {
                amount: formatRupiah(change),
              })
            : t("posKasirPayment.success.noChange")
        }
        description={[
          t("posKasirPayment.success.total", {
            amount: formatRupiah(bill.totalIdr),
          }),
          printedNo
            ? t(
                notPrinted
                  ? "posKasirPayment.success.receiptNotPrinted"
                  : print.isSuccess
                    ? "posKasirPayment.success.receiptPrinted"
                    : "posKasirPayment.success.receipt",
                { receiptNo: printedNo },
              )
            : null,
        ]
          .filter(Boolean)
          .join(" ")}
        aria-live="polite"
      >
        <dl className="grid w-full max-w-2xl gap-2 rounded-container bg-surface-3 p-4 text-left">
          {bill.deposit?.paid && (
            <Row
              label={t("posKasirPayment.success.deposit")}
              amountIdr={bill.deposit.amountIdr}
            />
          )}
          {confirmed.map((allocation) => (
            <Row
              key={allocation.id}
              label={
                allocation.method === "cash"
                  ? t("posKasirPayment.success.cashForBill")
                  : allocation.label
              }
              amountIdr={allocation.amountIdr}
            />
          ))}
          {cash && (
            <>
              <hr className="my-1 border-border" />
              <Row
                label={t("posKasirPayment.success.received")}
                amountIdr={cash.receivedIdr}
              />
              <Row
                label={t("posKasirPayment.success.changeLabel")}
                amountIdr={cash.changeIdr}
              />
            </>
          )}
        </dl>
        <PaidTicketCard orderId={orderId} />
        {held && (
          <Notice
            tone="warning"
            title={t("posKasirPayment.success.heldTitle")}
            className="w-full max-w-2xl text-left"
          >
            {t("posKasirPayment.success.heldHint")}
          </Notice>
        )}
        {notPrinted && (
          <ReceiptNotPrinted result={notPrinted} onSkip={toNewTransaction} />
        )}
        {print.isError && print.error.code === ORDER_COMPLETE_FAILED && (
          <Notice
            tone="danger"
            title={t("posKasirPayment.success.completeFailedTitle")}
            className="w-full max-w-2xl text-left"
          >
            {t("posKasirPayment.success.completeFailedHint")}
          </Notice>
        )}
        {print.isError && print.error.code !== ORDER_COMPLETE_FAILED && (
          <div className="grid w-full max-w-2xl justify-items-start gap-3">
            <Notice
              tone="danger"
              title={t("posKasirPayment.success.printFailedTitle")}
              className="w-full text-left"
            >
              {t("posKasirPayment.success.printFailedHint")}
            </Notice>
            <Button type="button" variant="outline" onClick={toNewTransaction}>
              {t("posKasirGateway.receipt.skipPrint")}
            </Button>
          </div>
        )}
      </StateBlock>
    </PosPanel>
  );
}
