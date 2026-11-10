import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useTenantContext } from "@/lib/tenant-context";
import {
  useCheckPaymentStatus,
  useRefreshQris,
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
  useAutoStart,
  useGatewayAttempt,
  useNow,
} from "./gateway-parts";
import type { PaymentPanelProps } from "./panel-types";

// QRIS for the cashier (bead legend-mjmm, P2). The QR code itself shows only on
// the customer display; this panel shows the status and the countdown. An
// expired QRIS is never shown as usable: the panel asks for the old payment's
// status once, then asks for a fresh QRIS.
export function QrisPanel(props: PaymentPanelProps) {
  const { orderId, amountIdr, onChangeMethod } = props;
  const t = useT();
  const { outlet } = useTenantContext();
  const { attempt, isLoading, error, refetch } = useGatewayAttempt(
    orderId,
    "qris",
  );
  const start = useStartPayment();
  const { mutateAsync: checkStatus, ...check } = useCheckPaymentStatus();
  const { mutateAsync: refreshQris, ...refresh } = useRefreshQris();
  const [renewTry, setRenewTry] = useState(0);
  const renewed = useRef<string | null>(null);

  const now = useNow(attempt?.status === "waiting");
  const remainingMs = remainingMsOf(attempt?.expiresAt, now);
  const expired =
    attempt !== null &&
    (attempt.status === "expired" ||
      (attempt.status === "waiting" && remainingMs === 0));
  const attemptId = attempt?.id;

  const { mutate: startQris } = start;
  const startNow = useCallback(
    () => startQris({ orderId, method: "qris", amountIdr }),
    [startQris, orderId, amountIdr],
  );
  useAutoStart(!isLoading && !error && attempt === null, orderId, startNow);

  useEffect(() => {
    if (!expired || attemptId === undefined) return;
    const key = `${attemptId}:${renewTry}`;
    if (renewed.current === key) return;
    renewed.current = key;
    const ref = { orderId, attemptId };
    checkStatus(ref)
      .then((next) =>
        next.activeAttempt?.id === attemptId &&
        next.activeAttempt.status === "expired"
          ? refreshQris(ref)
          : undefined,
      )
      .catch(() => undefined); // The mutation state shows the error below.
  }, [expired, attemptId, renewTry, orderId, checkStatus, refreshQris]);

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
          startLabel={t("posKasirGateway.common.retry")}
          startingLabel={t("posKasirGateway.qris.starting")}
          starting={!start.isError}
          onStart={startNow}
          error={start.error}
          onChangeMethod={onChangeMethod}
        />
      </LiveRegion>
    );

  if (attempt.status === "failed") return <FailedPanel {...props} />;
  if (attempt.status !== "waiting" && attempt.status !== "expired") return null;

  if (expired) {
    const renewing = check.isPending || refresh.isPending;
    const renewError = check.error ?? refresh.error;
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
        >
          {renewing && (
            <p
              role="status"
              className="mt-2 flex items-center gap-3 text-(length:--density-text) font-semibold"
            >
              <LoaderCircle
                className="size-6 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t("posKasirGateway.qris.renewing")}
            </p>
          )}
          {renewError != null && !renewing && (
            <BlockNotice>
              <ErrorNotice
                error={renewError}
                title={t("posKasirGateway.common.statusCheckError")}
              />
              <Button
                variant="outline"
                className="mt-3"
                onClick={() => setRenewTry((count) => count + 1)}
              >
                {t("posKasirGateway.common.retry")}
              </Button>
            </BlockNotice>
          )}
        </ExpiredPanel>
      </LiveRegion>
    );
  }

  const readyBody = outlet
    ? t("posKasirGateway.qris.readyBodyOutlet", { outlet: outlet.name })
    : t("posKasirGateway.qris.readyBody");
  return (
    <LiveRegion>
      <WaitingPanel
        orderId={orderId}
        attempt={attempt}
        title={title}
        statusLabel={t("posKasirGateway.common.statusWaiting")}
        heading={t("posKasirGateway.qris.readyHeading")}
        description={`${readyBody} ${t("posKasirGateway.qris.readyAction")}`}
        remainingMs={remainingMs}
        noticeTitle={t("posKasirGateway.common.waitingNoticeTitle")}
        noticeBody={t("posKasirGateway.common.waitingNoticeBody")}
      />
    </LiveRegion>
  );
}
