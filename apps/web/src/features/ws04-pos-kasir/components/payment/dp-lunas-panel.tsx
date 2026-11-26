import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleCheck } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";
import { ORDER_COMPLETE_FAILED } from "../../api";
import { usePaymentSession, usePrintReceipt } from "../../hooks";
import { ReceiptNotPrinted, wasQueued } from "./receipt-result-notice";
import { ReceiptSent } from "./receipt-sent-notice";

// The reservation DP covered the whole bill (legend-p7lx): no method, no cash,
// no change. The cashier only prints the receipt and starts the next
// transaction. The balance on the bill panel is Rp 0.
export function DpLunasPanel({
  orderId,
  depositIdr,
}: {
  orderId: string;
  depositIdr: number;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { receiptNo, completion } = usePaymentSession(orderId);
  const print = usePrintReceipt();
  const notPrinted =
    print.data && !wasQueued(print.data) ? print.data : undefined;
  const held = completion === "held";
  const toNewTransaction = () => void navigate({ to: "/pos/meja" });
  const reprint = () => print.mutate({ orderId });
  const sent = print.data && wasQueued(print.data) ? print.data : undefined;

  return (
    <PosPanel
      title={t("posKasirPayment.success.title")}
      aside={
        <StatusPill tone="success">
          {t("posKasirPayment.success.paidPill")}
        </StatusPill>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate({ to: "/pos/customer-display" })}
          >
            {t("posKasirPayment.success.eReceipt")}
          </Button>
          {print.data ? (
            // After a print the screen stays (review P2 no. 2): moving on is a tap.
            <Button type="button" onClick={toNewTransaction}>
              {t("posKasirCommon.printer.next")}
              <ArrowRight aria-hidden="true" />
            </Button>
          ) : (
            <Button
              type="button"
              disabled={print.isPending || held}
              aria-busy={print.isPending}
              onClick={reprint}
            >
              {print.isPending
                ? t("posKasirPayment.success.printing")
                : t("posKasirCommon.printer.print")}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex h-full flex-col justify-between gap-6">
        <StateBlock
          mark="ok"
          title={t("posKasirPayment.dpLunas.title")}
          description={t("posKasirPayment.dpLunas.body", {
            amount: formatRupiah(depositIdr),
          })}
          aria-live="polite"
          className="mx-auto max-w-xl"
        />
        <div className="grid gap-3">
          <div
            data-slot="notice"
            data-tone="success"
            className="rounded-control border-(length:--border-w) border-success bg-success-subtle px-4 py-3 text-success"
          >
            <p className="flex items-center gap-2 text-(length:--density-text) leading-6 font-semibold">
              <CircleCheck className="size-5 shrink-0" aria-hidden="true" />
              {t("posKasirPayment.dpLunas.noticeTitle")}
            </p>
            <p className="mt-1 text-base leading-6 text-foreground">
              {t("posKasirPayment.dpLunas.noticeBody")}
            </p>
          </div>
          {(receiptNo || print.data?.receiptNo) && (
            <p className="text-base text-muted-foreground">
              {t(
                notPrinted
                  ? "posKasirPayment.success.receiptNotPrinted"
                  : print.isSuccess
                    ? "posKasirPayment.success.receiptPrinted"
                    : "posKasirPayment.success.receipt",
                { receiptNo: print.data?.receiptNo ?? receiptNo ?? "" },
              )}
            </p>
          )}
          {held && (
            <Notice
              tone="warning"
              title={t("posKasirPayment.success.heldTitle")}
            >
              {t("posKasirPayment.success.heldHint")}
            </Notice>
          )}
          {sent && (
            <ReceiptSent
              receiptNo={sent.receiptNo}
              onReprint={reprint}
              reprinting={print.isPending}
            />
          )}
          {notPrinted && (
            <ReceiptNotPrinted
              result={notPrinted}
              onSkip={toNewTransaction}
              onReprint={reprint}
              reprinting={print.isPending}
            />
          )}
          {print.isError &&
            (print.error.code === ORDER_COMPLETE_FAILED ? (
              <Notice
                tone="danger"
                title={t("posKasirPayment.success.completeFailedTitle")}
              >
                {t("posKasirPayment.success.completeFailedHint")}
              </Notice>
            ) : (
              <div className="grid justify-items-start gap-3">
                <Notice
                  tone="danger"
                  title={t("posKasirPayment.success.printFailedTitle")}
                >
                  {t("posKasirPayment.success.printFailedHint")}
                </Notice>
                <Button
                  type="button"
                  variant="outline"
                  onClick={toNewTransaction}
                >
                  {t("posKasirGateway.receipt.skipPrint")}
                </Button>
              </div>
            ))}
        </div>
      </div>
    </PosPanel>
  );
}
