// EDC per terminal on the Tutup Hari check (X2-UI, legend-wasr7.18): receipts,
// what the bank file confirmed and the difference. Every figure is the
// server's; a terminal the bank file has not reached says so instead of
// showing Rp 0 (rules in ../../edc-settlement-view.ts).
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import {
  edcTerminalView,
  type EdcTerminalSettlement,
  type EdcTerminalState,
} from "../../edc-settlement-view";
import { StatusPill, type StatusPillTone } from "../shared";

const STATE_PILL: Record<
  Exclude<EdcTerminalState, "none">,
  {
    tone: StatusPillTone;
    label:
      | "posKasirDayclose.check.settlementWaiting"
      | "posKasirDayclose.check.settlementStateSettled"
      | "posKasirDayclose.check.settlementStatePartial"
      | "posKasirDayclose.check.settlementStateMismatch"
      | "posKasirDayclose.check.settlementStateNoMatch";
  }
> = {
  waiting: {
    tone: "warning",
    label: "posKasirDayclose.check.settlementWaiting",
  },
  settled: {
    tone: "success",
    label: "posKasirDayclose.check.settlementStateSettled",
  },
  partial: {
    tone: "warning",
    label: "posKasirDayclose.check.settlementStatePartial",
  },
  mismatch: {
    tone: "danger",
    label: "posKasirDayclose.check.settlementStateMismatch",
  },
  noMatch: {
    tone: "danger",
    label: "posKasirDayclose.check.settlementStateNoMatch",
  },
};

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="tabular">{children}</dd>
    </div>
  );
}

export function EdcSettlementLines({
  settlement,
}: {
  settlement: EdcTerminalSettlement[] | null;
}) {
  const t = useT();
  if (settlement === null)
    return <p>{t("posKasirDayclose.check.settlementPending")}</p>;
  if (settlement.length === 0)
    return <p>{t("posKasirDayclose.check.settlementNone")}</p>;
  return (
    <ul className="grid gap-3">
      {settlement.map((row) => {
        const view = edcTerminalView(row);
        const pill = view.state === "none" ? null : STATE_PILL[view.state];
        return (
          <li
            key={row.terminalId}
            className="grid gap-2 border-t-(length:--border-w) border-border pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">
                {t("posKasirDayclose.check.settlementTerminal", {
                  terminal: row.terminalCode,
                  bank: row.bank.toUpperCase(),
                })}
              </span>
              {pill && (
                <StatusPill tone={pill.tone}>{t(pill.label)}</StatusPill>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Figure label={t("posKasirDayclose.check.settlementReceipt")}>
                <Money amount={view.receiptIdr} />
              </Figure>
              {view.settledIdr !== null && view.differenceIdr !== null ? (
                <>
                  <Figure
                    label={t("posKasirDayclose.check.settlementBankLabel")}
                  >
                    <Money amount={view.settledIdr} />
                  </Figure>
                  <Figure
                    label={t("posKasirDayclose.check.settlementDifference")}
                  >
                    <Money amount={view.differenceIdr} />
                  </Figure>
                </>
              ) : null}
            </dl>
            {view.state === "noMatch" && (
              <p className="text-base">
                {t("posKasirDayclose.check.settlementNoMatchHint")}
              </p>
            )}
            {view.state === "waiting" && (
              <p className="text-base text-muted-foreground">
                {t("posKasirDayclose.check.settlementWaitingHint")}
              </p>
            )}
            {row.mismatchCount > 0 && (
              <p className="text-base">
                {t("posKasirDayclose.check.settlementMismatchLines", {
                  count: row.mismatchCount,
                })}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
