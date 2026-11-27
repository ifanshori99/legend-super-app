import { useState } from "react";
import { useT } from "@/components/i18n";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/ui/qr-code";
import { useEwallets, useStartPayment } from "../../hooks";
import { FailedPanel } from "./failed-panel";
import { FeeNoRefund, FeeQuote } from "./fee-lines";
import {
  ChoiceGroup,
  ExpiredPanel,
  LiveRegion,
  LoadingPanel,
  ProblemPanel,
  StartPanel,
  useGatewayAttempt,
} from "./gateway-parts";
import { OnlineCodeHold } from "./online-code-parts";
import { BlockNotice } from "./gateway-parts";
import { Notice } from "../shared";

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
import type { PaymentPanelProps } from "./panel-types";
import { PosPanel, StateBlock } from "../shared";

// E-wallet for the cashier (bead legend-mjmm, P2; Duitku 1269 C3b): pick the
// wallet, show the Duitku payment page as a QR for the customer's phone, then
// wait for the provider to confirm. One live code a bill, as for a QRIS.
export function EwalletPanel(props: PaymentPanelProps) {
  const { orderId, amountIdr, onChangeMethod } = props;
  const t = useT();
  const { attempt, isLoading, error, refetch } = useGatewayAttempt(
    orderId,
    "ewallet",
  );
  const wallets = useEwallets(orderId);
  const start = useStartPayment();
  const [walletCode, setWalletCode] = useState<string | null>(null);

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
    const options = (wallets.data ?? []).map((option) => ({
      ...option,
      hint: <FeeQuote feeIdr={option.guestFeeIdr} totalIdr={option.totalIdr} />,
    }));
    const chosen = options.find((option) => option.code === walletCode);
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
          <FeeNoRefund feeIdr={chosen?.guestFeeIdr} className="max-w-3xl" />
        </StartPanel>
      </LiveRegion>
    );
  }

  if (attempt.status === "failed") return <FailedPanel {...props} />;

  const wallet = attempt.ewallet?.label ?? t("posKasirGateway.method.ewallet");
  const panelTitle = t("posKasirGateway.ewallet.panelTitleNamed", { wallet });

  // Duitku proved the code dead (02): read the bill once more, then move on.
  if (attempt.status === "expired")
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
  if (attempt.status !== "waiting" && attempt.status !== "cancelling")
    return null;

  // Only a provider page over https is shown or opened (review C3b P3).
  const url = attempt.ewallet?.paymentUrl;
  const page = url && isHttpsUrl(url) ? url : undefined;
  return (
    <OnlineCodeHold
      orderId={orderId}
      attempt={attempt}
      title={panelTitle}
      statusLabel={t("posKasirGateway.common.statusWaiting")}
      heading={t("posKasirGateway.ewallet.readyHeading", { wallet })}
      description={t("posKasirGateway.ewallet.readyBody", { wallet })}
      noticeTitle={t("posKasirGateway.common.waitingNoticeTitle")}
      noticeBody={t("posKasirGateway.common.waitingNoticeBody")}
    >
      {url !== undefined && page === undefined && (
        <BlockNotice>
          <Notice tone="warning" title={t("posKasirGateway.code.oneCodeTitle")}>
            {t("posKasirGateway.ewallet.pageUnsafe")}
          </Notice>
        </BlockNotice>
      )}
      {page && (
        <div className="flex w-full max-w-3xl flex-col items-center gap-3 rounded-container bg-muted p-5 text-center">
          <QrCode
            value={page}
            label={t("posKasirGateway.ewallet.pageLabel", { wallet })}
            size={176}
            className="rounded-container p-2"
          />
          <p className="text-base text-muted-foreground">
            {t("posKasirGateway.ewallet.pageHint")}
          </p>
          <Button asChild variant="outline">
            <a
              href={page}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("posKasirGateway.ewallet.openPageLabel", {
                wallet,
              })}
            >
              {t("posKasirGateway.ewallet.openPage")}
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
        </div>
      )}
    </OnlineCodeHold>
  );
}
