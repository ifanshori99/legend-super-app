// Payroll runs list (PRD v1.7 §3 D.30, §4 Alur K; PAYR-01). The status band is
// the page's filter: every state of the run lifecycle with its count, one pill
// per state (icon + words, never color alone). The strip above the table is the
// newest simulated run's totals, not a page-wide sum, so the numbers match one
// payroll period (DESIGN.md §5 Management, Q30).
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarPlus, ChevronRight } from "lucide-react";
import type { PayrollRunStatus } from "@starter/shared/hris/payroll";
import type { AreaAccess } from "@/lib/areas/access";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "cn";
import { isOffline, payrollErrorMessage } from "../errors";
import { payrollAccess } from "../guard";
import { useRuns } from "../hooks";
import {
  formatBusinessDate,
  latestRunWithTotals,
  periodRange,
  RUN_STATUS_LABEL,
  RUN_STATUS_ORDER,
  RUN_STATUS_TONE,
  sortRuns,
  statusCounts,
} from "../lib";
import { RUNS_QUERY } from "../queries";
import { CreateRunDialog } from "./create-run-dialog";

type StatusFilter = PayrollRunStatus | "all";

export function RunListPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const navigate = useNavigate();
  const { canRun } = payrollAccess(access);
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [createOpen, setCreateOpen] = React.useState(false);

  const runs = useRuns({
    limit: RUNS_QUERY.limit,
    ...(filter === "all" ? {} : { status: filter }),
  });
  // The band's counts always describe the unfiltered set.
  const allRuns = useRuns({ limit: RUNS_QUERY.limit });

  const rows = React.useMemo(
    () => sortRuns(runs.data?.data ?? []),
    [runs.data],
  );
  const counts = React.useMemo(
    () => statusCounts(allRuns.data?.data ?? []),
    [allRuns.data],
  );
  const total = React.useMemo(
    () => (allRuns.data?.data ?? []).length,
    [allRuns.data],
  );
  const latest = React.useMemo(
    () => latestRunWithTotals(allRuns.data?.data ?? []),
    [allRuns.data],
  );

  const state: DataState = runs.isPending
    ? "loading"
    : runs.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";
  const filtered = filter !== "all";

  const openRun = (runId: string) => {
    void navigate({
      to: "/kelola/payroll/run/$runId",
      params: { runId },
    });
  };

  if (runs.isError && isOffline(runs.error)) {
    return (
      <ErrorState
        title={t("payrollRun.error.offlineTitle")}
        description={t("payrollRun.error.offlineHint")}
        onRetry={() => void runs.refetch()}
      />
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <section
        aria-label={t("payrollRun.list.statusBandLabel")}
        className="flex flex-col gap-3 rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline"
      >
        <div className="flex flex-col gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="type-title">{t("payrollRun.list.statusBandTitle")}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("payrollRun.list.statusBandHint")}
            </p>
          </div>
          {canRun && (
            <Button
              type="button"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <CalendarPlus aria-hidden="true" />
              {t("payrollRun.list.create")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
            className={cn(
              "rounded-full transition-shadow",
              filter === "all" &&
                "ring-2 ring-primary ring-offset-2 ring-offset-shell",
            )}
          >
            <Badge tone="neutral">
              {t("payrollRun.list.allStatuses", { count: total })}
            </Badge>
          </button>
          {RUN_STATUS_ORDER.map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
              className={cn(
                "rounded-full transition-shadow",
                filter === status &&
                  "ring-2 ring-primary ring-offset-2 ring-offset-shell",
              )}
            >
              <StatusPill status={RUN_STATUS_TONE[status]}>
                {`${t(RUN_STATUS_LABEL[status])} · ${counts[status]}`}
              </StatusPill>
            </button>
          ))}
        </div>
      </section>

      <StatStrip label={t("payrollRun.list.stripLabel")}>
        <StatTile
          label={t("payrollRun.list.gross")}
          value={
            latest?.totals ? (
              <Money amount={latest.totals.grossIdr} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={
            latest
              ? t("payrollRun.list.stripContext", {
                  period: periodRange(latest.periodStart, latest.periodEnd),
                })
              : t("payrollRun.list.stripNoRun")
          }
        />
        <StatTile
          label={t("payrollRun.list.deductions")}
          value={
            latest?.totals ? (
              <Money amount={latest.totals.deductionsIdr} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={t("payrollRun.list.deductionsContext")}
        />
        <StatTile
          label={t("payrollRun.list.net")}
          value={
            latest?.totals ? (
              <Money amount={latest.totals.netIdr} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={t("payrollRun.list.netContext")}
        />
        <StatTile
          label={t("payrollRun.list.employees")}
          value={
            latest?.totals ? (
              <NumberDisplay value={latest.totals.employeeCount} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={t("payrollRun.list.employeesContext")}
        />
      </StatStrip>

      <DataTableShell
        title={t("payrollRun.list.title")}
        description={t("payrollRun.list.description")}
        state={state}
        onRetry={() => void runs.refetch()}
        actions={
          canRun ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <CalendarPlus aria-hidden="true" />
              {t("payrollRun.list.create")}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("payrollRun.list.needRunPermission")}
            </p>
          )
        }
        empty={{
          title: filtered
            ? t("payrollRun.list.filterEmptyTitle")
            : t("payrollRun.list.emptyTitle"),
          description: filtered
            ? t("payrollRun.list.filterEmptyHint")
            : t("payrollRun.list.emptyHint"),
          action: filtered ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setFilter("all")}
            >
              {t("payrollRun.list.clearFilter")}
            </Button>
          ) : canRun ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <CalendarPlus aria-hidden="true" />
              {t("payrollRun.list.create")}
            </Button>
          ) : undefined,
        }}
        rowCount={rows.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("payrollRun.list.columnPeriod")}</TableHead>
              <TableHead>{t("payrollRun.list.columnPayDate")}</TableHead>
              <TableHead>{t("payrollRun.list.columnStatus")}</TableHead>
              <TableHead numeric>
                {t("payrollRun.list.columnEmployees")}
              </TableHead>
              <TableHead numeric>{t("payrollRun.list.columnGross")}</TableHead>
              <TableHead numeric>
                {t("payrollRun.list.columnDeductions")}
              </TableHead>
              <TableHead numeric>{t("payrollRun.list.columnNet")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("payrollRun.list.columnAction")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    to="/kelola/payroll/run/$runId"
                    params={{ runId: run.id }}
                    className="font-semibold underline-offset-4 hover:underline"
                  >
                    {periodRange(run.periodStart, run.periodEnd)}
                  </Link>
                  <p className="text-xs leading-4 text-muted-foreground">
                    {t(
                      run.runType === "regular"
                        ? "payrollRun.runType.regular"
                        : run.runType === "thr"
                          ? "payrollRun.runType.thr"
                          : "payrollRun.runType.offCycle",
                    )}
                  </p>
                </TableCell>
                <TableCell className="tabular">
                  {formatBusinessDate(run.payDate)}
                </TableCell>
                <TableCell>
                  <StatusPill status={RUN_STATUS_TONE[run.status]}>
                    {t(RUN_STATUS_LABEL[run.status])}
                  </StatusPill>
                </TableCell>
                <TableCell numeric className="tabular">
                  {run.totals ? (
                    <NumberDisplay value={run.totals.employeeCount} />
                  ) : (
                    <span className="text-muted-foreground">
                      {t("payrollRun.common.none")}
                    </span>
                  )}
                </TableCell>
                <TableCell numeric>
                  {run.totals ? (
                    <Money amount={run.totals.grossIdr} />
                  ) : (
                    <span className="text-muted-foreground">
                      {t("payrollRun.common.none")}
                    </span>
                  )}
                </TableCell>
                <TableCell numeric>
                  {run.totals ? (
                    <Money amount={run.totals.deductionsIdr} />
                  ) : (
                    <span className="text-muted-foreground">
                      {t("payrollRun.common.none")}
                    </span>
                  )}
                </TableCell>
                <TableCell numeric>
                  {run.totals ? (
                    <Money amount={run.totals.netIdr} />
                  ) : (
                    <span className="text-muted-foreground">
                      {t("payrollRun.common.none")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openRun(run.id)}
                  >
                    {t("payrollRun.list.open")}
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      {runs.isError && !isOffline(runs.error) && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {payrollErrorMessage(runs.error, t)}
        </p>
      )}

      <CreateRunDialog
        runs={allRuns.data?.data ?? []}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(run) => {
          setCreateOpen(false);
          openRun(run.id);
        }}
      />
    </div>
  );
}
