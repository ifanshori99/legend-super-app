import { ArrowRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { formatRupiah } from "@starter/shared/i18n";
import { usePaymentSession, useStartPayment } from "../../hooks";
import { tenderVoidMessageKey } from "../../tender-void-reason";
import type { PaymentAttempt } from "../../types";
import {
  BlockNotice,
  ErrorNotice,
  LiveRegion,
  LoadingPanel,
  ProblemPanel,
  paymentNo,
} from "./gateway-parts";
import type { PaymentPanelProps } from "./panel-types";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";

// A gateway payment the provider reported as failed (bead legend-mjmm, P2).
// The bill stays unpaid and the order stays saved: the cashier retries the same
// method (where that needs no new choice) or picks another one.
export function FailedPanel({ orderId, onChangeMethod }: PaymentPanelProps) {
  const t = useT();
  const { bill, activeAttempt, partialAllowed, isLoading, error, refetch } =
    usePaymentSession(orderId);
  const startPayment = useStartPayment();

  const attempt = activeAttempt?.status === "failed" ? activeAttempt : null;
  const methodLabel = attempt ? methodLabelOf(attempt, t) : "";
  const title = attempt
    ? `${methodLabel} · ${t("posKasirGateway.common.paymentNo", { no: paymentNo(attempt.sequence) })}`
    : t("posKasirGateway.failed.heading");

  if (isLoading) return <LoadingPanel title={title} />;
  if (error)
    return (
      <ProblemPanel
        title={title}
        error={error}
        onRetry={() => void refetch()}
        onChangeMethod={onChangeMethod}
      />
    );
  if (attempt === null) return null;

  // VA needs a bank choice and EDC a terminal choice: those go back to the grid.
  const canRetry =
    attempt.method === "qris" ||
    attempt.method === "card" ||
    (attempt.method === "ewallet" && attempt.ewallet !== undefined);
  const retrying = startPayment.isPending;
  const retryError = startPayment.error;
  const retry = () => {
    if (attempt.method === "qris" || attempt.method === "card")
      startPayment.mutate({
        orderId,
        method: attempt.method,
        // Without partial amounts the server takes the whole remaining balance.
        amountIdr:
          partialAllowed || !bill ? attempt.amountIdr : bill.remainingIdr,
      });
    else if (attempt.method === "ewallet" && attempt.ewallet)
      startPayment.mutate({
        orderId,
        method: "ewallet",
        amountIdr: attempt.amountIdr,
        walletCode: attempt.ewallet.code,
      });
  };

  const deposit = bill?.deposit;
  // legend-7e8kx: the server voided this QRIS and refunded it. Say why, instead
  // of the provider-failure text (the guest did pay; the money went back).
  const voided = attempt.voidReason !== undefined;
  return (
    <LiveRegion>
      <PosPanel
        title={title}
        aside={
          <StatusPill tone="danger">
            {t("posKasirGateway.common.statusFailed")}
          </StatusPill>
        }
        footer={
          <>
            {canRetry && !voided && (
              <Button variant="outline" loading={retrying} onClick={retry}>
                {retrying
                  ? t("posKasirGateway.failed.retrying")
                  : t("posKasirGateway.failed.retry", { method: methodLabel })}
              </Button>
            )}
            <Button onClick={onChangeMethod}>
              {t("posKasirGateway.failed.otherMethod")}
              <ArrowRight aria-hidden="true" />
            </Button>
          </>
        }
      >
        <StateBlock
          mark="fail"
          title={
            voided
              ? t("posKasirGateway.tenderVoided.title")
              : t("posKasirGateway.failed.heading")
          }
          description={
            voided
              ? t(tenderVoidMessageKey(attempt.voidReason))
              : t("posKasirGateway.failed.body")
          }
          amountIdr={attempt.amountIdr}
          className="py-4"
        >
          {!voided && (
            <BlockNotice>
              <Notice
                tone="danger"
                title={t("posKasirGateway.failed.noticeTitle", {
                  method: methodLabel,
                })}
              >
                {deposit?.paid
                  ? t("posKasirGateway.failed.noticeBodyDeposit", {
                      amount: formatRupiah(deposit.amountIdr),
                    })
                  : t("posKasirGateway.failed.noticeBody")}
              </Notice>
            </BlockNotice>
          )}
          {retryError != null && (
            <BlockNotice>
              <ErrorNotice
                error={retryError}
                title={t("posKasirGateway.common.startError")}
              />
            </BlockNotice>
          )}
        </StateBlock>
      </PosPanel>
    </LiveRegion>
  );
}

function methodLabelOf(
  attempt: PaymentAttempt,
  t: ReturnType<typeof useT>,
): string {
  if (attempt.method === "ewallet" && attempt.ewallet)
    return attempt.ewallet.label;
  return t(`posKasirGateway.method.${attempt.method}`);
}
