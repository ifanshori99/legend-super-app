import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, CircleX } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useStartPayment } from "../../hooks";
import type { PaymentAttempt, PaymentBill } from "../../types";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";
import { paymentNo } from "./gateway-parts";
import { EdcLayout, useEdcErrorText } from "./edc-side";

type EdcAttempt = PaymentAttempt & { edc: NonNullable<PaymentAttempt["edc"]> };

// The bank or terminal refused the transaction (not a technical failure and not
// unknown). Nothing was charged, so the cashier may resend to the same terminal
// or pick another method. The reason comes from the server as is.
export function EdcDeclined({
  orderId,
  bill,
  attempt,
  onChangeMethod,
}: {
  orderId: string;
  bill: PaymentBill;
  attempt: EdcAttempt;
  onChangeMethod: () => void;
}) {
  const t = useT();
  const errorText = useEdcErrorText();
  const start = useStartPayment();
  const retry = () => {
    if (start.isPending) return;
    start.mutate({
      orderId,
      method: "edc",
      amountIdr: attempt.amountIdr,
      terminalId: attempt.edc.terminalId,
      edcMode: attempt.edc.mode,
    });
  };
  const { declineReason, responseCode } = attempt.edc;
  return (
    <EdcLayout
      title={t("posKasirEdc.heading.declined")}
      bill={bill}
      headAction={
        <Button asChild variant="outline">
          <Link to="/pos/meja">
            <ArrowLeft aria-hidden="true" />
            {t("posKasirPayment.screen.back")}
          </Link>
        </Button>
      }
      sideLabel={t("posKasirEdc.side.remaining")}
      sideAmountIdr={bill.remainingIdr}
      sideTerminal={{
        title: attempt.edc.terminalLabel,
        detail: t(`posKasirEdc.side.mode.${attempt.edc.mode}`),
      }}
      sideNote={t("posKasirEdc.side.declinedNote")}
    >
      <PosPanel
        title={`${attempt.edc.terminalLabel} · ${t("posKasirGateway.common.paymentNo", { no: paymentNo(attempt.sequence) })}`}
        aside={
          <StatusPill tone="danger" icon={CircleX}>
            {t("posKasirEdc.pill.declined")}
          </StatusPill>
        }
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              loading={start.isPending}
              aria-busy={start.isPending}
              disabled={start.isPending}
              onClick={retry}
            >
              {start.isPending
                ? t("posKasirEdc.declined.retrying")
                : t("posKasirEdc.declined.retry")}
            </Button>
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={start.isPending}
              onClick={onChangeMethod}
            >
              {t("posKasirEdc.declined.otherMethod")}
              <ArrowRight aria-hidden="true" />
            </Button>
          </>
        }
      >
        <StateBlock
          mark="fail"
          title={declineReason ?? t("posKasirEdc.declined.reasonFallback")}
          description={t("posKasirEdc.declined.subtitle")}
          amountIdr={attempt.amountIdr}
          className="py-4"
        >
          {responseCode && (
            <p className="text-base text-muted-foreground">
              {t("posKasirEdc.declined.codeLabel")}{" "}
              <span className="tabular font-semibold text-foreground">
                {responseCode}
              </span>
            </p>
          )}
          <div className="grid w-full max-w-xl gap-3 text-left">
            <Notice tone="danger" title={t("posKasirEdc.declined.noticeTitle")}>
              {t("posKasirEdc.declined.noticeBody")}
            </Notice>
            {start.error && (
              <Notice
                tone="danger"
                title={t("posKasirEdc.declined.retryError")}
              >
                {errorText(start.error)}
              </Notice>
            )}
          </div>
        </StateBlock>
      </PosPanel>
    </EdcLayout>
  );
}
