import { useState } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useEwallets, useStartPayment } from "../../hooks";
import { FailedPanel } from "./failed-panel";
import {
  ChoiceGroup,
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
import { PosPanel, StateBlock } from "../shared";

// E-wallet for the cashier (bead legend-mjmm, P2): pick the wallet, send the
// request to the customer's app, then wait for the provider to confirm.
export function EwalletPanel(props: PaymentPanelProps) {
  const { orderId, amountIdr, onChangeMethod } = props;
  const t = useT();
  const { attempt, isLoading, error, refetch } = useGatewayAttempt(
    orderId,
    "ewallet",
  );
  const wallets = useEwallets();
  const start = useStartPayment();
  const [walletCode, setWalletCode] = useState<string | null>(null);
  const now = useNow(attempt?.status === "waiting");
  const remainingMs = remainingMsOf(attempt?.expiresAt, now);

  const title = t("posKasirGateway.ewallet.panelTitle");
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

  if (attempt === null) {
    if (wallets.isLoading) return <LoadingPanel title={title} />;
    if (wallets.error)
      return (
        <ProblemPanel
          title={title}
          error={wallets.error}
          onRetry={() => void wallets.refetch()}
          onChangeMethod={onChangeMethod}
        />
      );
    const options = wallets.data ?? [];
    if (options.length === 0)
      return (
        <PosPanel
          title={title}
          footer={
            <Button onClick={onChangeMethod}>
              {t("posKasirGateway.common.otherMethod")}
            </Button>
          }
        >
          <StateBlock
            title={t("posKasirGateway.ewallet.noWallets")}
            description={t("posKasirGateway.ewallet.noWalletsHint")}
          />
        </PosPanel>
      );
    return (
      <LiveRegion>
        <StartPanel
          title={title}
          heading={t("posKasirGateway.ewallet.pickHeading")}
          body={t("posKasirGateway.ewallet.pickBody")}
          amountIdr={amountIdr}
          startLabel={t("posKasirGateway.ewallet.start")}
          startingLabel={t("posKasirGateway.ewallet.starting")}
          starting={start.isPending}
          startDisabled={walletCode === null}
          onStart={() =>
            walletCode !== null &&
            start.mutate({
              orderId,
              method: "ewallet",
              amountIdr,
              walletCode,
            })
          }
          error={start.error}
          onChangeMethod={onChangeMethod}
        >
          <ChoiceGroup
            legend={t("posKasirGateway.ewallet.walletGroup")}
            name="ewallet"
            options={options}
            value={walletCode}
            onChange={setWalletCode}
          />
        </StartPanel>
      </LiveRegion>
    );
  }

  if (attempt.status === "failed") return <FailedPanel {...props} />;
  if (attempt.status !== "waiting" && attempt.status !== "expired") return null;

  const wallet = attempt.ewallet?.label ?? t("posKasirGateway.method.ewallet");
  const panelTitle = t("posKasirGateway.ewallet.panelTitleNamed", { wallet });

  if (attempt.status === "expired" || remainingMs === 0)
    return (
      <LiveRegion>
        <ExpiredPanel
          orderId={orderId}
          attempt={attempt}
          title={panelTitle}
          heading={t("posKasirGateway.ewallet.expiredHeading")}
          description={t("posKasirGateway.ewallet.expiredBody")}
          noticeBody={t("posKasirGateway.ewallet.expiredNoticeBody")}
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
        title={panelTitle}
        statusLabel={t("posKasirGateway.common.statusWaiting")}
        heading={t("posKasirGateway.ewallet.readyHeading", { wallet })}
        description={t("posKasirGateway.ewallet.readyBody", { wallet })}
        remainingMs={remainingMs}
        noticeTitle={t("posKasirGateway.common.waitingNoticeTitle")}
        noticeBody={t("posKasirGateway.common.waitingNoticeBody")}
      />
    </LiveRegion>
  );
}
