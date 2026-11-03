// The Kas & Bank strip: one StatStrip (DESIGN.md v3 / Q30) for the KPIs that
// answer "how much cash is still out, how many lines need a person, and are we
// at the ACC-04 auto-match target?". The contract has no bank-balance field
// (see the bead report), so the strip shows only endpoint-backed figures.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import type { BankAccount } from "@starter/shared/accounting";
import {
  autoMatchTargetPercent,
  autoMatchTargetReached,
  businessDateToday,
  formatBasisPoints,
  openCases,
  pendingMatchCount,
  totalOpenDifference,
  totalUndeposited,
} from "../lib";
import {
  useReconciliationCases,
  useReconciliationSummary,
  useUndepositedAlerts,
} from "../hooks";

export function CashSummaryStrip({
  legalEntityId,
  account,
  from,
  to,
}: {
  legalEntityId: string;
  account: BankAccount | undefined;
  from: string;
  to: string;
}) {
  const t = useT();
  const today = businessDateToday();
  const summary = useReconciliationSummary(account?.id, from, to);
  const alerts = useUndepositedAlerts(legalEntityId, today);
  const cases = useReconciliationCases(legalEntityId, "all");

  if (!account)
    return (
      <CardShell>
        <CardShellBody>
          <EmptyState
            title={t("accounting.cash.strip.noAccount")}
            description={t("accounting.cash.accounts.emptyHint")}
          />
        </CardShellBody>
      </CardShell>
    );

  if (summary.isPending || alerts.isPending || cases.isPending) {
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
  }

  if (summary.isError || alerts.isError || cases.isError) {
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            onRetry={() => {
              void summary.refetch();
              void alerts.refetch();
              void cases.refetch();
            }}
          />
        </CardShellBody>
      </CardShell>
    );
  }

  const undeposited = totalUndeposited(alerts.data);
  const pending = pendingMatchCount(summary.data);
  const open = openCases(cases.data.data);
  const openDifference = totalOpenDifference(cases.data.data);
  const rateBp = summary.data.autoMatchRateBp;
  const reached = autoMatchTargetReached(rateBp);
  return (
    <StatStrip label={t("accounting.cash.strip.label")} columns={4}>
      <StatTile
        label={t("accounting.cash.strip.undeposited")}
        value={<Money amount={undeposited} size="stat" />}
        context={
          alerts.data.length === 0
            ? t("accounting.cash.strip.undepositedClear")
            : t("accounting.cash.strip.undepositedContext", {
                count: alerts.data.length,
              })
        }
        source={
          <a href="#cash-deposits">{t("accounting.cash.deposits.title")}</a>
        }
      />
      <StatTile
        label={t("accounting.cash.strip.unmatched")}
        value={<NumberDisplay value={pending} size="stat" />}
        context={t("accounting.cash.strip.unmatchedContext", {
          count: summary.data.lineCount,
        })}
        source={<a href="#cash-match">{t("accounting.cash.match.title")}</a>}
      />
      <StatTile
        label={t("accounting.cash.strip.openDifference")}
        value={<Money amount={openDifference} size="stat" />}
        context={
          open.length === 0
            ? t("accounting.cash.strip.openDifferenceClear")
            : t("accounting.cash.strip.openDifferenceContext", {
                count: open.length,
              })
        }
        source={
          <Link to="/kelola/akuntansi/rekonsiliasi">
            {t("accounting.cash.recon.title")}
          </Link>
        }
      />
      <StatTile
        label={t("accounting.cash.strip.autoMatch")}
        value={<span className="tabular">{formatBasisPoints(rateBp)}</span>}
        context={`${t("accounting.cash.strip.autoMatchContext", {
          target: autoMatchTargetPercent(),
        })} · ${
          reached
            ? t("accounting.cash.strip.autoMatchReached")
            : t("accounting.cash.strip.autoMatchBelow")
        }`}
        source={
          <Link to="/kelola/akuntansi/rekonsiliasi">
            {t("accounting.cash.recon.title")}
          </Link>
        }
      />
    </StatStrip>
  );
}
