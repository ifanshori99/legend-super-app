// Reconciliation summary for the selected bank account: the ACC-04 auto-match
// rate as a labelled figure against the ≥99% target (never a fake gauge), plus
// the counts the rate is made of.
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import type { BankAccount } from "@starter/shared/accounting";
import {
  autoMatchTargetPercent,
  autoMatchTargetReached,
  formatBasisPoints,
} from "../lib";
import { useReconciliationSummary } from "../hooks";

export function ReconSummaryStrip({
  account,
  from,
  to,
}: {
  account: BankAccount | undefined;
  from: string;
  to: string;
}) {
  const t = useT();
  const summary = useReconciliationSummary(account?.id, from, to);

  if (!account)
    return (
      <CardShell>
        <CardShellBody>
          <EmptyState
            title={t("accounting.cash.recon.settlement.emptyTitle")}
            description={t("accounting.cash.recon.settlement.emptyHint")}
          />
        </CardShellBody>
      </CardShell>
    );

  if (summary.isPending)
    return (
      <div
        className="grid gap-2 rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline sm:grid-cols-2 lg:grid-cols-4"
        aria-busy="true"
      >
        <span className="sr-only">{t("common.loading")}</span>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    );

  if (summary.isError)
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            onRetry={() => {
              void summary.refetch();
            }}
          />
        </CardShellBody>
      </CardShell>
    );

  const rateBp = summary.data.autoMatchRateBp;
  const reached = autoMatchTargetReached(rateBp);
  return (
    <StatStrip label={t("accounting.cash.recon.summary.label")} columns={4}>
      <StatTile
        label={t("accounting.cash.recon.summary.autoMatch")}
        value={<span className="tabular">{formatBasisPoints(rateBp)}</span>}
        context={`${t("accounting.cash.recon.summary.target", {
          target: autoMatchTargetPercent(),
        })} · ${
          reached
            ? t("accounting.cash.recon.summary.reached")
            : t("accounting.cash.recon.summary.below")
        }`}
      />
      <StatTile
        label={t("accounting.cash.recon.summary.autoMatched")}
        value={
          <NumberDisplay value={summary.data.autoMatchedCount} size="stat" />
        }
        context={t("accounting.cash.recon.summary.total", {
          count: summary.data.lineCount,
        })}
      />
      <StatTile
        label={t("accounting.cash.recon.summary.unmatched")}
        value={
          <NumberDisplay value={summary.data.unmatchedCount} size="stat" />
        }
        context={t("accounting.cash.recon.summary.total", {
          count: summary.data.lineCount,
        })}
      />
      <StatTile
        label={t("accounting.cash.recon.summary.inCase")}
        value={<NumberDisplay value={summary.data.inCaseCount} size="stat" />}
        context={t("accounting.cash.recon.summary.manualContext", {
          count: summary.data.manuallyMatchedCount,
        })}
      />
    </StatStrip>
  );
}
