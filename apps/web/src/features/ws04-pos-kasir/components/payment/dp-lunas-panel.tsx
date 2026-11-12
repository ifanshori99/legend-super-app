import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleCheck } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";
import { usePaymentSession, usePrintReceipt } from "../../hooks";

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
  const { receiptNo } = usePaymentSession(orderId);
  const print = usePrintReceipt();
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
        <div className="flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate({ to: "/pos/customer-display" })}
          >
            {t("posKasirPayment.success.eReceipt")}
          </Button>
          <Button
            type="button"
            disabled={print.isPending}
            aria-busy={print.isPending}
            onClick={() =>
              print.mutate({ orderId }, { onSuccess: toNewTransaction })
            }
          >
            {print.isPending
              ? t("posKasirPayment.success.printing")
              : t("posKasirPayment.success.printAndNew")}
            <ArrowRight aria-hidden="true" />
          </Button>
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
                print.isSuccess
                  ? "posKasirPayment.success.receiptPrinted"
                  : "posKasirPayment.success.receipt",
                { receiptNo: print.data?.receiptNo ?? receiptNo ?? "" },
              )}
            </p>
          )}
          {print.isError && (
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
          )}
        </div>
      </div>
    </PosPanel>
  );
}
