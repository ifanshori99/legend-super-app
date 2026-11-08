import { useState } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useOutletClock } from "@/lib/tenant-context";
import { useStartPayment, useVaBanks } from "../../hooks";
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

/** "8 Nov 2026 · 14.42" in the outlet time zone. */
function formatDeadline(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(date);
  const time = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
  return `${day} · ${time}`;
}

// Virtual Account for the cashier (bead legend-mjmm, P2): pick the bank, then
// show the number and the deadline. The bill stays unpaid until the provider
// verifies the transfer, never from a transfer slip.
export function VaPanel(props: PaymentPanelProps) {
  const { orderId, amountIdr, onChangeMethod } = props;
  const t = useT();
  const { timeZone } = useOutletClock();
  const { attempt, isLoading, error, refetch } = useGatewayAttempt(
    orderId,
    "va",
  );
  const banks = useVaBanks();
  const start = useStartPayment();
  const [bankCode, setBankCode] = useState<string | null>(null);
  const now = useNow(attempt?.status === "waiting");
  // One deadline for both the expiry and the printed "batas pembayaran".
  const deadline = attempt?.va?.deadline ?? attempt?.expiresAt;
  const remainingMs = remainingMsOf(deadline, now);

  const title = t("posKasirGateway.va.panelTitle");
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
    if (banks.isLoading) return <LoadingPanel title={title} />;
    if (banks.error)
      return (
        <ProblemPanel
          title={title}
          error={banks.error}
          onRetry={() => void banks.refetch()}
          onChangeMethod={onChangeMethod}
        />
      );
    const options = banks.data ?? [];
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
            title={t("posKasirGateway.va.noBanks")}
            description={t("posKasirGateway.va.noBanksHint")}
          />
        </PosPanel>
      );
    return (
      <LiveRegion>
        <StartPanel
          title={title}
          heading={t("posKasirGateway.va.pickHeading")}
          body={t("posKasirGateway.va.pickBody")}
          amountIdr={amountIdr}
          startLabel={t("posKasirGateway.va.start")}
          startingLabel={t("posKasirGateway.va.starting")}
          starting={start.isPending}
          startDisabled={bankCode === null}
          onStart={() =>
            bankCode !== null &&
            start.mutate({
              orderId,
              method: "va",
              amountIdr,
              bankCode,
            })
          }
          error={start.error}
          onChangeMethod={onChangeMethod}
        >
          <ChoiceGroup
            legend={t("posKasirGateway.va.bankGroup")}
            name="va-bank"
            options={options}
            value={bankCode}
            onChange={setBankCode}
          />
        </StartPanel>
      </LiveRegion>
    );
  }

  if (attempt.status === "failed") return <FailedPanel {...props} />;
  if (attempt.status !== "waiting" && attempt.status !== "expired") return null;

  if (attempt.status === "expired" || remainingMs === 0)
    return (
      <LiveRegion>
        <ExpiredPanel
          orderId={orderId}
          attempt={attempt}
          title={title}
          heading={t("posKasirGateway.va.expiredHeading")}
          description={t("posKasirGateway.va.expiredBody")}
          noticeBody={t("posKasirGateway.va.expiredNoticeBody")}
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
        statusLabel={t("posKasirGateway.va.statusWaiting")}
        heading={t("posKasirGateway.va.readyHeading")}
        description={`${attempt.va?.bank ?? ""} · ${t("posKasirGateway.va.readyBody")}`}
        noticeTitle={t("posKasirGateway.va.noticeTitle")}
        noticeBody={t("posKasirGateway.va.noticeBody")}
      >
        {attempt.va && deadline !== undefined && (
          <div className="w-full max-w-3xl rounded-container bg-muted p-5 text-center">
            <p className="text-base text-muted-foreground">
              {t("posKasirGateway.va.numberLabel")}
            </p>
            <p className="tabular text-3xl font-semibold tracking-[0.05em]">
              {attempt.va.number}
            </p>
            <div className="mt-3 flex items-baseline justify-between gap-3 text-(length:--density-text)">
              <span>{t("posKasirGateway.va.deadline")}</span>
              <strong className="tabular">
                {formatDeadline(deadline, timeZone)}
              </strong>
            </div>
          </div>
        )}
      </WaitingPanel>
    </LiveRegion>
  );
}
