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
  useGatewayAttempt,
} from "./gateway-parts";
import { OnlineCodeHold } from "./online-code-parts";
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

// Virtual Account for the cashier (bead legend-mjmm, P2; Duitku 1269 C3b): pick
// the bank, then show the number and the deadline. The bill stays unpaid until
// the provider verifies the transfer, never from a transfer slip, and takes no
// other payment while the code lives (one live code a bill).
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

  // Duitku proved the code dead (02): read the bill once more, then move on.
  if (attempt.status === "expired")
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
  if (attempt.status !== "waiting" && attempt.status !== "cancelling")
    return null;

  return (
    <OnlineCodeHold
      orderId={orderId}
      attempt={attempt}
      title={title}
      statusLabel={t("posKasirGateway.va.statusWaiting")}
      heading={t("posKasirGateway.va.readyHeading")}
      description={t("posKasirGateway.va.readyBody", {
        bank: attempt.va?.bank ?? t("posKasirGateway.method.va"),
      })}
      noticeTitle={t("posKasirGateway.va.noticeTitle")}
      noticeBody={t("posKasirGateway.va.noticeBody")}
    >
      {attempt.va && (
        <div className="w-full max-w-3xl rounded-container bg-muted p-5 text-center">
          <p className="text-base text-muted-foreground">
            {t("posKasirGateway.va.numberLabel")}
          </p>
          <p className="tabular text-2xl font-semibold break-all sm:text-3xl sm:tracking-[0.05em]">
            {attempt.va.number}
          </p>
          <div className="mt-3 flex flex-col items-center gap-1 text-(length:--density-text) sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <span>{t("posKasirGateway.va.deadline")}</span>
            <strong className="tabular">
              {formatDeadline(attempt.va.deadline, timeZone)}
            </strong>
          </div>
        </div>
      )}
    </OnlineCodeHold>
  );
}
