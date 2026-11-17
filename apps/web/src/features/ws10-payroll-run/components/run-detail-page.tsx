// Payroll run wizard (PRD v1.7 §4 Alur K; PAYR-01, PAYR-02, PAYR-04, PAYR-05).
// One screen holds the whole journey: the persistent status header with the
// step rail, the run's totals, the per-employee review with its delta against
// the previous run, the exports, and the audit strip. Every write goes through
// the dialogs in run-actions.tsx.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { AreaAccess } from "@/lib/areas/access";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import type { DataState } from "@/components/ui/data-table-shell";
import { isOffline, payrollErrorMessage } from "../errors";
import { payrollAccess } from "../guard";
import { useBankFiles, useRun, useRunResults } from "../hooks";
import { AuditTrail } from "./audit-trail";
import { EmployeeReviewTable } from "./employee-review-table";
import { ExportsSection } from "./exports-section";
import { HeldOvertimeCorrections } from "./held-overtime-corrections";
import { RunActionDialogs, type RunDialog } from "./run-actions";
import { RunStatusHeader } from "./run-status-header";

function DetailSkeleton() {
  const t = useT();
  return (
    <div className="grid gap-4" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function RunDetailPage({
  runId,
  access,
}: {
  runId: string;
  access: AreaAccess;
}) {
  const t = useT();
  const permissions = payrollAccess(access);
  const run = useRun(runId);
  // Salary rows are PII (HR-03) and bank files need payroll.lock: a visitor
  // without the permission never requests them (legend-t3f5 reads stop at the
  // run row and its totals).
  const results = useRunResults(runId, permissions.canViewSalaries);
  const files = useBankFiles(runId, permissions.canLock);
  const [dialog, setDialog] = React.useState<RunDialog | null>(null);

  if (run.isPending) return <DetailSkeleton />;

  if (run.isError) {
    const offline = isOffline(run.error);
    return (
      <div className="grid gap-4">
        <Button variant="outline" size="sm" asChild className="w-fit">
          <Link to="/kelola/payroll/run">
            <ArrowLeft aria-hidden="true" />
            {t("payrollRun.detail.back")}
          </Link>
        </Button>
        <ErrorState
          title={
            offline
              ? t("payrollRun.error.offlineTitle")
              : t("payrollRun.loadErrorTitle")
          }
          description={
            offline
              ? t("payrollRun.error.offlineHint")
              : payrollErrorMessage(run.error, t)
          }
          onRetry={() => void run.refetch()}
        />
      </div>
    );
  }

  const data = run.data;
  const rows = results.data?.data ?? [];
  const fileRows = files.data?.data ?? [];
  const resultsState: DataState = !permissions.canViewSalaries
    ? "empty"
    : results.isPending
      ? "loading"
      : results.isError
        ? "error"
        : rows.length === 0
          ? "empty"
          : "ready";
  const totals = data.totals;
  const none = (
    <span className="text-muted-foreground">{t("payrollRun.common.none")}</span>
  );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Button variant="ghost" size="sm" asChild className="w-fit">
        <Link to="/kelola/payroll/run">
          <ArrowLeft aria-hidden="true" />
          {t("payrollRun.detail.back")}
        </Link>
      </Button>

      <RunStatusHeader run={data} access={permissions} onAction={setDialog} />

      <StatStrip label={t("payrollRun.detail.stripLabel")}>
        <StatTile
          label={t("payrollRun.detail.gross")}
          value={totals ? <Money amount={totals.grossIdr} size="stat" /> : none}
          context={t("payrollRun.detail.grossContext")}
        />
        <StatTile
          label={t("payrollRun.detail.deductions")}
          value={
            totals ? <Money amount={totals.deductionsIdr} size="stat" /> : none
          }
          context={
            totals
              ? t("payrollRun.detail.deductionsContext", {
                  bpjs: formatRupiah(totals.bpjsEmployeeIdr),
                  pph: formatRupiah(totals.pph21WithheldIdr),
                })
              : t("payrollRun.detail.noSimulation")
          }
        />
        <StatTile
          label={t("payrollRun.detail.net")}
          value={totals ? <Money amount={totals.netIdr} size="stat" /> : none}
          context={
            totals
              ? t("payrollRun.detail.netSplit", {
                  transfer: formatRupiah(totals.bankTransferIdr),
                  cash: formatRupiah(totals.cashIdr),
                })
              : t("payrollRun.detail.noSimulation")
          }
        />
        <StatTile
          label={t("payrollRun.detail.employees")}
          value={
            totals ? (
              <NumberDisplay value={totals.employeeCount} size="stat" />
            ) : (
              none
            )
          }
          context={t("payrollRun.detail.employeesContext")}
        />
      </StatStrip>

      <HeldOvertimeCorrections
        run={data}
        rows={rows}
        resultsState={resultsState}
        canViewSalaries={permissions.canViewSalaries}
      />

      <EmployeeReviewTable
        run={data}
        rows={rows}
        state={resultsState}
        onRetry={() => void results.refetch()}
        canSimulate={permissions.canRun}
        restricted={!permissions.canViewSalaries}
        onSimulate={() => setDialog("simulate")}
      />

      <ExportsSection
        run={data}
        files={fileRows}
        canExport={permissions.canLock}
        canViewSalaries={permissions.canViewSalaries}
      />

      <AuditTrail run={data} />

      <RunActionDialogs
        run={data}
        files={fileRows}
        dialog={dialog}
        canDecideReversal={permissions.canDecideReversal}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
