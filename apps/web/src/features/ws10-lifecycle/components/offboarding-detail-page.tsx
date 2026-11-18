// One employee's offboarding (PRD v1.7 §3 D26 "Offboarding"): the exit
// clearance checklist, the final-settlement estimate read from the payroll
// endpoints (payroll.view only), and the work certificate preview.
//
// Exit clearance gates the end of the flow: the certificate (and its own
// checklist task) stays locked until every other offboarding task is done or
// waived and the employee has actually left.
import { useRouteContext } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { ApiError } from "@/lib/api/errors";
import type { AreaAccess } from "@/lib/areas/access";
import {
  useChecklistTasks,
  useEmployee,
  useEmployeeDirectory,
  useOrgUnits,
  usePositions,
} from "../hooks.ts";
import {
  certificateFor,
  certificateLock,
  checklistProgress,
  exitClearance,
  liveOffboardingId,
  templateForPosition,
  templatesFor,
} from "../lib.ts";
import { CertificateCard } from "./certificate-dialog.tsx";
import { ChecklistCard } from "./checklist-card.tsx";
import { EmployeeHeader } from "./employee-header.tsx";
import { FinalSettlementCard } from "./final-settlement-card.tsx";
import { MetricValue, type MetricsState } from "./metric-value.tsx";

const TEMPLATES = templatesFor("offboarding");

export function OffboardingDetailPage({ employeeId }: { employeeId: string }) {
  const t = useT();
  const { access } = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  // HR-03: salary amounts need payroll.view; fail closed without context.
  const canViewSalary = access?.permissions.includes("payroll.view") ?? false;
  const employee = useEmployee(employeeId);
  const positions = usePositions();
  const orgUnits = useOrgUnits();
  const directory = useEmployeeDirectory();
  const tasks = useChecklistTasks(employeeId, "offboarding");

  const notFound =
    employee.error instanceof ApiError && employee.error.status === 404;

  if (
    employee.isPending ||
    positions.isPending ||
    orgUnits.isPending ||
    directory.isPending
  )
    return (
      <div className="grid gap-5" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );

  if (notFound)
    return (
      <EmptyState
        title={t("lifecycle.error.employeeNotFound")}
        description={t("lifecycle.error.employeeNotFoundHint")}
      />
    );

  if (employee.isError)
    return (
      <ErrorState
        onRetry={() => {
          void employee.refetch();
        }}
      />
    );

  const row = employee.data;
  if (!row) return null;

  const positionRows = positions.data?.data ?? [];
  const employees = directory.data?.data ?? [];
  const taskRows = tasks.data?.data ?? [];
  const progress = checklistProgress(taskRows);
  const metricsState: MetricsState = tasks.isPending
    ? "loading"
    : tasks.isError
      ? "error"
      : "ready";
  const clearance = exitClearance(taskRows);
  const lock = tasks.isSuccess
    ? certificateLock(row, clearance)
    : "clearanceOpen";
  const clearanceMessage = !tasks.isSuccess
    ? null
    : clearance.cleared
      ? t("lifecycle.clearance.cleared")
      : taskRows.length === 0
        ? t("lifecycle.clearance.noTasks")
        : t("lifecycle.clearance.blocked", {
            count: clearance.blockers.length,
          });
  const template = templateForPosition(
    TEMPLATES,
    "offboarding",
    row.positionId,
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <EmployeeHeader
        employee={row}
        positions={positionRows}
        orgUnits={orgUnits.data?.data ?? []}
        backTo="/kelola/offboarding"
        backLabel={t("lifecycle.offboarding.detail.back")}
      />
      <StatStrip label={t("lifecycle.metrics.checklistLabel")} columns={4}>
        <StatTile
          label={t("lifecycle.metrics.total")}
          value={<MetricValue state={metricsState} value={progress.total} />}
          context={
            metricsState === "ready"
              ? t("lifecycle.metrics.percentContext", {
                  percent: progress.percent,
                })
              : undefined
          }
        />
        <StatTile
          label={t("lifecycle.metrics.done")}
          value={<MetricValue state={metricsState} value={progress.complete} />}
        />
        <StatTile
          label={t("lifecycle.metrics.open")}
          value={<MetricValue state={metricsState} value={progress.open} />}
        />
        <StatTile
          label={t("lifecycle.metrics.blocked")}
          value={<MetricValue state={metricsState} value={progress.blocked} />}
        />
      </StatStrip>
      <p
        role="status"
        aria-live="polite"
        className="text-(length:--density-text) font-medium"
      >
        {clearanceMessage}
      </p>
      <ChecklistCard
        title={t("lifecycle.offboarding.detail.checklistTitle")}
        tasks={tasks.data?.data ?? []}
        template={template}
        isPending={tasks.isPending}
        isError={tasks.isError}
        onRetry={() => {
          void tasks.refetch();
        }}
        actionLock={(task, action) =>
          action === "complete" &&
          task.category === "work_certificate" &&
          !clearance.cleared
            ? t("lifecycle.clearance.certificateTaskLocked")
            : null
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <FinalSettlementCard
          employee={row}
          offboardingId={liveOffboardingId(taskRows)}
          canViewSalary={canViewSalary}
        />
        <CertificateCard
          certificate={certificateFor(row, positionRows, employees)}
          lock={lock}
        />
      </div>
    </div>
  );
}
