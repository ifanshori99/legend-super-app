import { ArrowRight, CircleX } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useStartPayment } from "../../hooks";
import type { PaymentAttempt, PaymentBill } from "../../types";
import { Notice, PosPanel } from "../shared";
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
      headPill={{
        tone: "danger",
        icon: CircleX,
        label: t("posKasirEdc.pill.declined"),
      }}
      sideLabel={t("posKasirEdc.declined.amountLabel")}
      sideAmountIdr={attempt.amountIdr}
      sidePill={{ tone: "danger", label: t("posKasirEdc.pill.declined") }}
      sideTerminal={{
        title: attempt.edc.terminalLabel,
        detail: t(`posKasirEdc.side.mode.${attempt.edc.mode}`),
      }}
      sideNote={t("posKasirEdc.side.declinedNote")}
    >
      <PosPanel
        title={t("posKasirEdc.declined.title")}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
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
              disabled={start.isPending}
              onClick={onChangeMethod}
            >
              {t("posKasirEdc.declined.otherMethod")}
              <ArrowRight aria-hidden="true" />
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <p className="text-(length:--density-text) text-muted-foreground">
            {t("posKasirEdc.declined.subtitle")}
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-base text-muted-foreground">
                {t("posKasirEdc.declined.reasonLabel")}
              </dt>
              <dd className="text-(length:--density-text) font-semibold">
                {declineReason ?? t("posKasirEdc.declined.reasonFallback")}
              </dd>
            </div>
            {responseCode && (
              <div>
                <dt className="text-base text-muted-foreground">
                  {t("posKasirEdc.declined.codeLabel")}
                </dt>
                <dd className="tabular text-(length:--density-text) font-semibold">
                  {responseCode}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-base text-muted-foreground">
                {t("posKasirEdc.declined.terminalLabel")}
              </dt>
              <dd className="text-(length:--density-text) font-semibold">
                {attempt.edc.terminalLabel}
              </dd>
            </div>
          </dl>
          <Notice tone="danger" title={t("posKasirEdc.declined.noticeTitle")}>
            {t("posKasirEdc.declined.noticeBody")}
          </Notice>
          {start.error && (
            <Notice tone="danger" title={t("posKasirEdc.declined.retryError")}>
              {errorText(start.error)}
            </Notice>
          )}
        </div>
      </PosPanel>
    </EdcLayout>
  );
}
