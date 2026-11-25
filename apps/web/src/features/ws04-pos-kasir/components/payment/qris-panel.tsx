import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useTenantContext } from "@/lib/tenant-context";
import {
  useCancelAttempt,
  useCheckPaymentStatus,
  useStartPayment,
} from "../../hooks";
import { FailedPanel } from "./failed-panel";
import {
  BlockNotice,
  ErrorNotice,
  ExpiredPanel,
  LiveRegion,
  LoadingPanel,
  ProblemPanel,
  StartPanel,
  WaitingPanel,
  remainingMsOf,
  safeToLeave,
  useGatewayAttempt,
  useNow,
} from "./gateway-parts";
import type { PaymentPanelProps } from "./panel-types";

// QRIS for the cashier (bead legend-mjmm, P2). The QR code itself shows only on
// the customer display; this panel shows the status and the countdown. A QRIS is
// made only by the cashier's tap, never when the panel opens and never again by
// itself (1268 W2). Until the provider proves the old code is dead, whatever the
// clock says, the bill stays locked and no new code is offered.
export function QrisPanel({
  starter,
  ...props
}: PaymentPanelProps & {
  /** The start the payment screen's own "Lanjutkan" tap already made. */
  starter?: ReturnType<typeof useStartPayment>;
}) {
  const { orderId, amountIdr, onChangeMethod } = props;
  const t = useT();
  const { outlet } = useTenantContext();
  const { attempt, isLoading, error, refetch } = useGatewayAttempt(
    orderId,
    "qris",
  );
  const own = useStartPayment();
  const start = starter ?? own;
  const check = useCheckPaymentStatus();
  const cancel = useCancelAttempt();

  const now = useNow(attempt?.status === "waiting");
  const remainingMs = remainingMsOf(attempt?.expiresAt, now);

  const startNow = () => start.mutate({ orderId, method: "qris", amountIdr });

  const title = t("posKasirGateway.qris.panelTitle");
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

  if (attempt === null)
    return (
      <LiveRegion>
        <StartPanel
          title={title}
          heading={t("posKasirGateway.qris.startHeading")}
          body={t("posKasirGateway.qris.startBody")}
          amountIdr={amountIdr}
          startLabel={t(
            start.isError
              ? "posKasirGateway.common.retry"
              : "posKasirGateway.qris.start",
          )}
          startingLabel={t("posKasirGateway.qris.starting")}
          starting={start.isPending}
          onStart={startNow}
          error={start.error}
          onChangeMethod={onChangeMethod}
        />
      </LiveRegion>
    );

  if (attempt.status === "failed") return <FailedPanel {...props} />;

  if (attempt.status === "expired") {
    const renewing = check.isPending || start.isPending;
    const renewError = check.error ?? start.error;
    // A customer may have paid just as the code expired: read the bill first.
    const renew = () =>
      void check
        .mutateAsync({ orderId, attemptId: attempt.id })
        .then((next) => {
          if (safeToLeave(next, attempt.id))
            start.mutate({
              orderId,
              method: "qris",
              amountIdr: next.bill.remainingIdr,
            });
        })
        .catch(() => undefined); // The mutation state shows the error below.
    return (
      <LiveRegion>
        <ExpiredPanel
          orderId={orderId}
          attempt={attempt}
          title={title}
          heading={t("posKasirGateway.qris.expiredHeading")}
          description={`${t("posKasirGateway.qris.expiredBody")} ${t("posKasirGateway.qris.expiredWarn")}`}
          noticeBody={t("posKasirGateway.qris.expiredNoticeBody")}
          onChangeMethod={onChangeMethod}
          showCheck={false}
          action={
            <Button variant="outline" loading={renewing} onClick={renew}>
              {renewing
                ? t("posKasirGateway.qris.renewing")
                : t("posKasirGateway.qris.renew")}
            </Button>
          }
        >
          {renewError != null && !renewing && (
            <BlockNotice>
              <ErrorNotice
                error={renewError}
                title={t("posKasirGateway.common.startError")}
              />
            </BlockNotice>
          )}
        </ExpiredPanel>
      </LiveRegion>
    );
  }

  if (attempt.status !== "waiting" && attempt.status !== "cancelling")
    return null;

  const cancelling = attempt.status === "cancelling";
  const hidden = attempt.qrShown === false;
  const lapsed = remainingMs === 0;
  const readyBody = outlet
    ? t("posKasirGateway.qris.readyBodyOutlet", { outlet: outlet.name })
    : t("posKasirGateway.qris.readyBody");
  return (
    <LiveRegion>
      <WaitingPanel
        orderId={orderId}
        attempt={attempt}
        title={title}
        statusLabel={t(
          cancelling
            ? "posKasirGateway.qris.cancellingStatus"
            : "posKasirGateway.common.statusWaiting",
        )}
        heading={t(
          cancelling
            ? "posKasirGateway.qris.cancellingHeading"
            : hidden || lapsed
              ? "posKasirGateway.qris.hiddenHeading"
              : "posKasirGateway.qris.readyHeading",
        )}
        description={
          cancelling
            ? t("posKasirGateway.qris.cancellingBody")
            : lapsed
              ? t("posKasirGateway.qris.lapsedBody")
              : hidden
                ? t("posKasirGateway.qris.hiddenBody")
                : `${readyBody} ${t("posKasirGateway.qris.readyAction")}`
        }
        remainingMs={cancelling || hidden || lapsed ? undefined : remainingMs}
        noticeTitle={t("posKasirGateway.common.waitingNoticeTitle")}
        noticeBody={t(
          cancelling
            ? "posKasirPayment.holdActive.title"
            : "posKasirGateway.common.waitingNoticeBody",
        )}
        action={
          attempt.cancellable && (
            <Button
              variant="outline"
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate({
                  orderId,
                  attemptId: attempt.id,
                  method: "qris",
                })
              }
            >
              {t("posKasirGateway.qris.cancel")}
            </Button>
          )
        }
      >
        {cancel.error != null && (
          <BlockNotice>
            <ErrorNotice
              error={cancel.error}
              title={t("posKasirGateway.qris.cancelError")}
            />
          </BlockNotice>
        )}
      </WaitingPanel>
    </LiveRegion>
  );
}
