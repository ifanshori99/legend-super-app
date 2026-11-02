// One employee's offboarding (PRD v1.7 §3 D26 "Offboarding"): the exit
// clearance checklist, the final-settlement summary read from the payroll
// fixtures, and the work certificate preview.
//
// None of the three has an endpoint yet (no task action, no settlement, no
// certificate), so each block states its source and the gaps stay visible
// instead of being papered over with a computed total.
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { ApiError } from "@/lib/api/errors";
import {
  useChecklistTasks,
  useEmployee,
  useEmployeeDirectory,
  useOrgUnits,
  usePositions,
} from "../hooks.ts";
import {
  certificateFor,
  checklistProgress,
  templateForPosition,
  templatesFor,
} from "../lib.ts";
import { CertificateCard } from "./certificate-dialog.tsx";
import { ChecklistCard } from "./checklist-card.tsx";
import { EmployeeHeader } from "./employee-header.tsx";
import { FinalSettlementCard } from "./final-settlement-card.tsx";

const TEMPLATES = templatesFor("offboarding");

export function OffboardingDetailPage({ employeeId }: { employeeId: string }) {
  const t = useT();
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
  const progress = checklistProgress(tasks.data?.data ?? []);
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
          value={<NumberDisplay value={progress.total} size="stat" />}
          context={t("lifecycle.metrics.percentContext", {
            percent: progress.percent,
          })}
        />
        <StatTile
          label={t("lifecycle.metrics.done")}
          value={<NumberDisplay value={progress.complete} size="stat" />}
        />
        <StatTile
          label={t("lifecycle.metrics.open")}
          value={<NumberDisplay value={progress.open} size="stat" />}
        />
        <StatTile
          label={t("lifecycle.metrics.blocked")}
          value={<NumberDisplay value={progress.blocked} size="stat" />}
        />
      </StatStrip>
      <ChecklistCard
        title={t("lifecycle.offboarding.detail.checklistTitle")}
        tasks={tasks.data?.data ?? []}
        template={template}
        isPending={tasks.isPending}
        isError={tasks.isError}
        onRetry={() => {
          void tasks.refetch();
        }}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <FinalSettlementCard employeeId={employeeId} />
        <CertificateCard
          certificate={certificateFor(row, positionRows, employees)}
        />
      </div>
    </div>
  );
}
