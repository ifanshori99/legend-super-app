import { Check, CircleCheck, Printer } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { usePrintReceipt } from "../../hooks";
import type { OrderCompletion, PaymentAttempt, PaymentBill } from "../../types";
import { Notice, PosPanel } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";
import { ReceiptNotPrinted, wasQueued } from "./receipt-result-notice";

type EdcAttempt = PaymentAttempt & { edc: NonNullable<PaymentAttempt["edc"]> };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b-(length:--border-w) border-border py-3 text-(length:--density-text)">
      <dt>{label}</dt>
      <dd className="tabular text-right font-semibold">{value}</dd>
    </div>
  );
}

// The bank approved (or a supervisor recorded the slip by hand): proof lines,
// the receipt and the way back to the till.
export function EdcSuccess({
  orderId,
  bill,
  attempt,
  receiptNo,
  completion,
}: {
  orderId: string;
  bill: PaymentBill;
  attempt: EdcAttempt;
  receiptNo?: string;
  completion?: OrderCompletion;
}) {
  const t = useT();
  const errorText = useEdcErrorText();
  const print = usePrintReceipt();
  const amountText = formatRupiah(attempt.amountIdr);
  const standalone = attempt.standalone === true;
  return (
    <EdcLayout
      title={t("posKasirEdc.heading.success")}
      bill={bill}
      headPill={{ tone: "success", label: t("posKasirEdc.pill.paid") }}
      sideLabel={t("posKasirEdc.side.paid")}
      sideAmountIdr={attempt.amountIdr}
      sidePill={{ tone: "success", label: t("posKasirEdc.side.paidPill") }}
      sideTerminal={{
        title: attempt.edc.terminalLabel,
        detail: `${t(`posKasirEdc.side.mode.${attempt.edc.mode}`)} · ${
          standalone
            ? t("posKasirEdc.side.standalone")
            : t("posKasirEdc.side.connected")
        }`,
      }}
      sideNote={t("posKasirEdc.side.successNote")}
    >
      <PosPanel
        title={t(
          standalone
            ? "posKasirEdc.success.standaloneTitle"
            : "posKasirEdc.success.title",
        )}
        aside={
          <span className="grid size-10 place-items-center rounded-control bg-success-subtle text-success">
            <Check className="size-6" aria-hidden="true" />
          </span>
        }
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              loading={print.isPending}
              disabled={completion === "held"}
              onClick={() => print.mutate({ orderId })}
            >
              <Printer aria-hidden="true" />
              {t(
                receiptNo
                  ? "posKasirEdc.success.reprint"
                  : "posKasirEdc.success.print",
              )}
            </Button>
            <Button asChild>
              <Link to="/pos">{t("posKasirEdc.success.back")}</Link>
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <p className="text-(length:--density-text) text-muted-foreground">
            {t(
              standalone
                ? "posKasirEdc.success.standaloneSubtitle"
                : "posKasirEdc.success.subtitle",
            )}
          </p>
          <dl>
            <Row
              label={t("posKasirEdc.success.terminal")}
              value={attempt.edc.terminalLabel}
            />
            <Row
              label={t("posKasirEdc.success.method")}
              value={
                attempt.cardMasked ??
                t(`posKasirEdc.side.mode.${attempt.edc.mode}`)
              }
            />
            {attempt.bankRef && (
              <Row
                label={t("posKasirEdc.success.bankRef")}
                value={attempt.bankRef}
              />
            )}
            {attempt.approvalCode && (
              <Row
                label={t("posKasirEdc.success.approval")}
                value={attempt.approvalCode}
              />
            )}
            {attempt.posRef && (
              <Row
                label={t("posKasirEdc.success.posRef")}
                value={attempt.posRef}
              />
            )}
          </dl>
          {standalone && (
            <Notice
              tone="warning"
              title={t("posKasirEdc.success.reconcileTitle")}
            >
              {t("posKasirEdc.success.reconcileBody")}
            </Notice>
          )}
          {receiptNo && (
            <div
              data-slot="notice"
              data-tone="success"
              className="rounded-control border-(length:--border-w) border-success bg-success-subtle px-4 py-3 text-success"
            >
              <p className="flex items-center gap-2 text-(length:--density-text) leading-6 font-semibold">
                <CircleCheck className="size-5 shrink-0" aria-hidden="true" />
                {t("posKasirEdc.success.receiptTitle")}
              </p>
              <p className="mt-1 text-base leading-6 text-foreground">
                {bill.deposit
                  ? t("posKasirEdc.success.receiptDeposit", {
                      receiptNo,
                      deposit: formatRupiah(bill.deposit.amountIdr),
                      amount: amountText,
                    })
                  : t("posKasirEdc.success.receiptBody", { receiptNo })}
              </p>
            </div>
          )}
          {completion === "held" && (
            <Notice
              tone="warning"
              title={t("posKasirPayment.success.heldTitle")}
            >
              {t("posKasirPayment.success.heldHint")}
            </Notice>
          )}
          <div aria-live="polite">
            {print.isSuccess && wasQueued(print.data) && (
              <p className="text-base">{t("posKasirEdc.success.reprinted")}</p>
            )}
            {print.isSuccess && !wasQueued(print.data) && (
              <ReceiptNotPrinted result={print.data} />
            )}
          </div>
          {print.error && (
            <Notice tone="danger" title={t("posKasirEdc.success.reprintError")}>
              {errorText(print.error)}
            </Notice>
          )}
        </div>
      </PosPanel>
    </EdcLayout>
  );
}
