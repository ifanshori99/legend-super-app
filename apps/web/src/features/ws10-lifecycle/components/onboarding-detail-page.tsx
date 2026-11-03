// One employee's onboarding checklist (PRD v1.7 §3 D26 "Onboarding", §4 Alur M
// steps 1–5). The header names the employee and their placement, one StatStrip
// summarises the checklist, and the checklist card groups the tasks by category
// with the actions the contract allows.
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { ApiError } from "@/lib/api/errors";
import {
  useChecklistTasks,
  useEmployee,
  useOrgUnits,
  usePositions,
} from "../hooks.ts";
import {
  checklistProgress,
  templateForPosition,
  templatesFor,
} from "../lib.ts";
import { ChecklistCard } from "./checklist-card.tsx";
import { MetricValue, type MetricsState } from "./metric-value.tsx";
import { EmployeeHeader } from "./employee-header.tsx";

const TEMPLATES = templatesFor("onboarding");

export function OnboardingDetailPage({ employeeId }: { employeeId: string }) {
  const t = useT();
  const employee = useEmployee(employeeId);
  const positions = usePositions();
  const orgUnits = useOrgUnits();
  const tasks = useChecklistTasks(employeeId, "onboarding");

  const notFound =
    employee.error instanceof ApiError && employee.error.status === 404;

  if (employee.isPending || positions.isPending || orgUnits.isPending)
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

  const progress = checklistProgress(tasks.data?.data ?? []);
  const metricsState: MetricsState = tasks.isPending
    ? "loading"
    : tasks.isError
      ? "error"
      : "ready";
  const template = templateForPosition(TEMPLATES, "onboarding", row.positionId);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <EmployeeHeader
        employee={row}
        positions={positions.data?.data ?? []}
        orgUnits={orgUnits.data?.data ?? []}
        backTo="/kelola/onboarding"
        backLabel={t("lifecycle.onboarding.detail.back")}
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
      <ChecklistCard
        title={t("lifecycle.onboarding.detail.checklistTitle")}
        tasks={tasks.data?.data ?? []}
        template={template}
        isPending={tasks.isPending}
        isError={tasks.isError}
        onRetry={() => {
          void tasks.refetch();
        }}
      />
    </div>
  );
}
