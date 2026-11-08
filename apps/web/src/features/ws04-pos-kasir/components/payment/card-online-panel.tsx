import { useT } from "@/components/i18n";
import { useStartPayment } from "../../hooks";
import { FailedPanel } from "./failed-panel";
import {
  ExpiredPanel,
  LiveRegion,
  LoadingPanel,
  ProblemPanel,
  StartPanel,
  WaitingPanel,
  remainingMsOf,
  useGatewayAttempt,
  useNow,
} from "./gateway-parts";
import type { PaymentPanelProps } from "./panel-types";

// Online card for the cashier (bead legend-mjmm, P2). The customer types the
// card on the customer display; the cashier never sees the card number, only
// the status the provider reports.
export function CardOnlinePanel(props: PaymentPanelProps) {
  const { orderId, amountIdr, onChangeMethod } = props;
  const t = useT();
  const { attempt, isLoading, error, refetch } = useGatewayAttempt(
    orderId,
    "card",
  );
  const start = useStartPayment();
  const now = useNow(attempt?.status === "waiting");
  const remainingMs = remainingMsOf(attempt?.expiresAt, now);

  const title = t("posKasirGateway.card.panelTitle");
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
          heading={t("posKasirGateway.card.startHeading")}
          body={t("posKasirGateway.card.startBody")}
          amountIdr={amountIdr}
          startLabel={t("posKasirGateway.card.start")}
          startingLabel={t("posKasirGateway.card.starting")}
          starting={start.isPending}
          onStart={() => start.mutate({ orderId, method: "card", amountIdr })}
          error={start.error}
          onChangeMethod={onChangeMethod}
        />
      </LiveRegion>
    );

  if (attempt.status === "failed") return <FailedPanel {...props} />;
  if (attempt.status !== "waiting" && attempt.status !== "expired") return null;

  if (attempt.status === "expired" || remainingMs === 0)
    return (
      <LiveRegion>
        <ExpiredPanel
          orderId={orderId}
          attempt={attempt}
          title={title}
          heading={t("posKasirGateway.card.expiredHeading")}
          description={t("posKasirGateway.card.expiredBody")}
          noticeBody={t("posKasirGateway.card.expiredNoticeBody")}
          onChangeMethod={onChangeMethod}
          showCheck
        />
      </LiveRegion>
    );

  return (
    <LiveRegion>
      <WaitingPanel
        orderId={orderId}
        attempt={attempt}
        title={title}
        statusLabel={t("posKasirGateway.common.statusWaiting")}
        heading={t("posKasirGateway.card.readyHeading")}
        description={t("posKasirGateway.card.readyBody")}
        remainingMs={remainingMs}
        noticeTitle={t("posKasirGateway.common.waitingNoticeTitle")}
        noticeBody={t("posKasirGateway.common.waitingNoticeBody")}
      />
    </LiveRegion>
  );
}
