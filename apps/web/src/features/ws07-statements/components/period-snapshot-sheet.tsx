// Closed-period snapshot (read-only): the balances frozen at close, the
// trial-balance totals at period end and the P&L net profit for the month.
// Every figure is a server value; the sheet only places them.
import type { FiscalPeriod } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatBusinessDate,
  formatDateTime,
  formatPeriod,
  isSnapshotHistory,
  periodBounds,
  shortUserId,
  statementQueryFor,
} from "../lib";
import { PeriodStatusBadge } from "./status-badges";
import {
  useAccounts,
  usePeriodSnapshot,
  useProfitAndLossStatement,
  useTrialBalance,
} from "../hooks";

export function PeriodSnapshotSheet({
  open,
  onOpenChange,
  legalEntityId,
  period,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  period: FiscalPeriod | null;
}) {
  const t = useT();
  const bounds = period ? periodBounds(period.period) : null;
  const snapshot = usePeriodSnapshot(period?.id, open && period !== null);
  const trial = useTrialBalance(
    legalEntityId,
    bounds?.end,
    open && period !== null,
  );
  const pnlQuery = statementQueryFor("profitAndLoss", legalEntityId, {
    from: bounds?.start ?? "1970-01-01",
    to: bounds?.end ?? "1970-01-01",
  });
  const pnl = useProfitAndLossStatement(pnlQuery, open && period !== null);
  const accountsQuery = useAccounts(legalEntityId);
  const accountsById = new Map(
    (accountsQuery.data ?? []).map((account) => [account.id, account]),
  );

  const loading = snapshot.isPending || trial.isPending || pnl.isPending;
  const failed = snapshot.isError || trial.isError || pnl.isError;

  return (
    <Sheet open={open && period !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:w-[min(40rem,calc(100%-3rem))]"
      >
        <SheetHeader className="border-b-(length:--border-w) border-border p-card">
          <SheetTitle>
            {t("accounting.report.periods.snapshotDialog.title", {
              period: period ? formatPeriod(period.period) : "",
            })}
          </SheetTitle>
          <SheetDescription>
            {t("accounting.report.periods.snapshotDialog.description")}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="grid gap-2 p-card" aria-busy="true">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-24" />
              <Skeleton className="h-40" />
            </div>
          )}

          {!loading && failed && (
            <ErrorState
              title={t("accounting.report.periods.snapshotDialog.errorTitle")}
              description={t("state.errorHint")}
              onRetry={() => {
                void snapshot.refetch();
                void trial.refetch();
                void pnl.refetch();
              }}
            />
          )}

          {!loading && !failed && snapshot.data && period && bounds && (
            <div className="grid gap-5 p-card">
              <StatStrip
                label={t(
                  "accounting.report.periods.snapshotDialog.summaryLabel",
                )}
                columns={3}
              >
                <StatTile
                  label={t(
                    "accounting.report.periods.snapshotDialog.totalDebit",
                  )}
                  value={
                    <Money
                      amount={trial.data?.totalDebitIdr ?? 0}
                      size="stat"
                    />
                  }
                  context={t("accounting.report.periods.closeDialog.totals", {
                    date: formatBusinessDate(bounds.end),
                  })}
                />
                <StatTile
                  label={t(
                    "accounting.report.periods.snapshotDialog.totalCredit",
                  )}
                  value={
                    <Money
                      amount={trial.data?.totalCreditIdr ?? 0}
                      size="stat"
                    />
                  }
                />
                <StatTile
                  label={t(
                    "accounting.report.periods.snapshotDialog.netProfit",
                  )}
                  value={
                    <Money amount={pnl.data?.netProfitIdr ?? 0} size="stat" />
                  }
                  context={formatPeriod(period.period)}
                />
              </StatStrip>

              {isSnapshotHistory(snapshot.data) && (
                <div
                  role="status"
                  className="grid gap-0.5 rounded-md border-(length:--border-w) border-border bg-muted p-3 text-sm"
                >
                  <p className="font-medium">
                    {t("accounting.report.periods.snapshotDialog.historyTitle")}
                  </p>
                  <p className="text-muted-foreground">
                    {t("accounting.report.periods.snapshotDialog.historyHint")}
                  </p>
                </div>
              )}

              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="grid gap-0.5">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("accounting.report.periods.snapshotDialog.version")}
                  </dt>
                  <dd className="tabular font-medium">
                    {snapshot.data.version}
                  </dd>
                </div>
                {snapshot.data.periodStatus && (
                  <div className="grid gap-0.5">
                    <dt className="type-eyebrow text-muted-foreground">
                      {t(
                        "accounting.report.periods.snapshotDialog.periodStatus",
                      )}
                    </dt>
                    <dd>
                      <PeriodStatusBadge status={snapshot.data.periodStatus} />
                    </dd>
                  </div>
                )}
                {snapshot.data.periodVersion !== undefined && (
                  <div className="grid gap-0.5">
                    <dt className="type-eyebrow text-muted-foreground">
                      {t(
                        "accounting.report.periods.snapshotDialog.periodVersion",
                      )}
                    </dt>
                    <dd className="tabular font-medium">
                      {snapshot.data.periodVersion}
                    </dd>
                  </div>
                )}
                <div className="grid gap-0.5">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("accounting.report.periods.snapshotDialog.takenAt")}
                  </dt>
                  <dd className="tabular">
                    {formatDateTime(snapshot.data.takenAt)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("accounting.report.periods.snapshotDialog.takenBy")}
                  </dt>
                  <dd className="font-mono text-xs break-all">
                    {shortUserId(snapshot.data.takenBy)}
                  </dd>
                </div>
              </dl>

              <div className="grid gap-2">
                <h3 className="type-title">
                  {t("accounting.report.periods.snapshotDialog.balances")}
                </h3>
                {snapshot.data.balances.length === 0 ? (
                  <EmptyState
                    title={t(
                      "accounting.report.periods.snapshotDialog.missingTitle",
                    )}
                    description={t(
                      "accounting.report.periods.snapshotDialog.missingHint",
                    )}
                  />
                ) : (
                  <Table className="min-w-[36rem]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t(
                            "accounting.report.periods.snapshotDialog.columns.account",
                          )}
                        </TableHead>
                        <TableHead numeric>
                          {t(
                            "accounting.report.periods.snapshotDialog.columns.debit",
                          )}
                        </TableHead>
                        <TableHead numeric>
                          {t(
                            "accounting.report.periods.snapshotDialog.columns.credit",
                          )}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.data.balances.map((balance) => {
                        const account = accountsById.get(balance.accountId);
                        return (
                          <TableRow key={balance.accountId}>
                            <TableCell>
                              <span className="flex min-w-0 items-baseline gap-2">
                                <span className="tabular text-xs text-muted-foreground">
                                  {account?.code ?? ""}
                                </span>
                                <span className="min-w-0">
                                  {account?.name ?? balance.accountId}
                                </span>
                              </span>
                            </TableCell>
                            <TableCell numeric>
                              {balance.debitIdr === 0 ? (
                                <span aria-hidden="true">—</span>
                              ) : (
                                <Money amount={balance.debitIdr} />
                              )}
                            </TableCell>
                            <TableCell numeric>
                              {balance.creditIdr === 0 ? (
                                <span aria-hidden="true">—</span>
                              ) : (
                                <Money amount={balance.creditIdr} />
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
