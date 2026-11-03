// Onboarding list (PRD v1.7 §3 D26 "Onboarding", §4 Alur M step 5: a
// supervisor watches onboarding progress). Rows are the employees the tenant is
// onboarding plus the active employees who still have an open onboarding task,
// each with the checklist template of its position and its progress.
//
// No checklist-template endpoint exists yet, so the template column reads the
// shared fixture (follow-up bead). Progress comes from the contract's task
// rows, never from a stored counter.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Employee } from "@starter/shared/hris";
import {
  useChecklistTasksForEmployees,
  useEmployeeDirectory,
  usePositions,
} from "../hooks.ts";
import {
  checklistProgress,
  clearanceComplete,
  formatBusinessDate,
  onboardingCandidates,
  positionName,
  templateForPosition,
  templatesFor,
  type ChecklistProgress,
} from "../lib.ts";
import { MetricValue } from "./metric-value.tsx";

const TEMPLATES = templatesFor("onboarding");

function matchesSearch(employee: Employee, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  if (needle === "") return true;
  return (
    employee.fullName.toLocaleLowerCase("id-ID").includes(needle) ||
    employee.employeeNo.toLocaleLowerCase("id-ID").includes(needle)
  );
}

type Row = {
  employee: Employee;
  progress: ChecklistProgress;
  templateTitle: string | null;
};

export function OnboardingPage() {
  const t = useT();
  const [search, setSearch] = React.useState("");

  const directory = useEmployeeDirectory();
  const positions = usePositions();
  const candidates = React.useMemo(
    () => onboardingCandidates(directory.data?.data ?? []),
    [directory.data],
  );
  const checklists = useChecklistTasksForEmployees(
    candidates.map((employee) => employee.id),
    "onboarding",
  );

  // A row is an employee being onboarded, or an active employee whose
  // onboarding checklist is not finished yet (PRD D26 "Onboarding").
  const rows = React.useMemo<Row[]>(() => {
    const visible: Row[] = [];
    for (const employee of candidates) {
      const tasks = checklists.tasks.get(employee.id) ?? [];
      const onboarding = employee.status === "onboarding";
      if (!onboarding && (tasks.length === 0 || clearanceComplete(tasks)))
        continue;
      if (!matchesSearch(employee, search)) continue;
      visible.push({
        employee,
        progress: checklistProgress(tasks),
        templateTitle:
          templateForPosition(TEMPLATES, "onboarding", employee.positionId)
            ?.title ?? null,
      });
    }
    return visible.sort(
      (left, right) =>
        left.employee.joinDate.localeCompare(right.employee.joinDate) ||
        left.employee.fullName.localeCompare(right.employee.fullName, "id-ID"),
    );
  }, [candidates, checklists.tasks, search]);

  const totals = React.useMemo(() => {
    const progress = rows.map((row) => row.progress);
    return {
      employees: rows.filter((row) => row.employee.status === "onboarding")
        .length,
      open: progress.reduce((sum, row) => sum + row.open, 0),
      blocked: progress.reduce((sum, row) => sum + row.blocked, 0),
      complete: rows.filter(
        (row) =>
          row.progress.total > 0 &&
          row.progress.complete === row.progress.total,
      ).length,
    };
  }, [rows]);

  const state: DataState =
    directory.isPending || positions.isPending || checklists.isPending
      ? "loading"
      : directory.isError || positions.isError || checklists.isError
        ? "error"
        : rows.length === 0 && search.trim() === ""
          ? "empty"
          : "ready";

  const retry = () => {
    void directory.refetch();
    void positions.refetch();
    checklists.refetch();
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatStrip
        label={t("lifecycle.onboarding.list.metricsLabel")}
        columns={4}
      >
        <StatTile
          label={t("lifecycle.onboarding.list.metrics.employees")}
          value={<MetricValue state={state} value={totals.employees} />}
          context={t("lifecycle.onboarding.list.metricsContext")}
        />
        <StatTile
          label={t("lifecycle.onboarding.list.metrics.open")}
          value={<MetricValue state={state} value={totals.open} />}
        />
        <StatTile
          label={t("lifecycle.onboarding.list.metrics.blocked")}
          value={<MetricValue state={state} value={totals.blocked} />}
        />
        <StatTile
          label={t("lifecycle.onboarding.list.metrics.complete")}
          value={<MetricValue state={state} value={totals.complete} />}
        />
      </StatStrip>

      <DataTableShell
        title={t("lifecycle.onboarding.list.title")}
        description={t("lifecycle.onboarding.list.description")}
        state={state}
        onRetry={retry}
        search={{
          value: search,
          onChange: setSearch,
          label: t("lifecycle.onboarding.list.search"),
        }}
        noResults={state === "ready" && rows.length === 0}
        rowCount={
          state === "ready" && rows.length > 0 ? rows.length : undefined
        }
        empty={{
          title: t("lifecycle.onboarding.list.empty"),
          description: t("lifecycle.onboarding.list.emptyHint"),
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("lifecycle.onboarding.list.columns.employee")}
              </TableHead>
              <TableHead>
                {t("lifecycle.onboarding.list.columns.position")}
              </TableHead>
              <TableHead>
                {t("lifecycle.onboarding.list.columns.template")}
              </TableHead>
              <TableHead>
                {t("lifecycle.onboarding.list.columns.start")}
              </TableHead>
              <TableHead>
                {t("lifecycle.onboarding.list.columns.progress")}
              </TableHead>
              <TableHead className="text-right">
                {t("lifecycle.onboarding.list.columns.open")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.employee.id}>
                <TableCell className="min-w-40">
                  <div className="grid gap-0.5">
                    <span className="font-medium">{row.employee.fullName}</span>
                    <span className="text-sm text-muted-foreground tabular">
                      {t("lifecycle.common.nipValue", {
                        nip: row.employee.employeeNo,
                      })}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {positionName(
                    positions.data?.data ?? [],
                    row.employee.positionId,
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.templateTitle ?? t("lifecycle.common.noTemplate")}
                </TableCell>
                <TableCell className="tabular whitespace-nowrap">
                  {formatBusinessDate(row.employee.joinDate)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular whitespace-nowrap">
                      {t("lifecycle.common.taskProgress", {
                        done: row.progress.complete,
                        total: row.progress.total,
                      })}
                    </span>
                    {row.progress.blocked > 0 && (
                      <Badge tone="warning">
                        {t("lifecycle.common.blockedCount", {
                          count: row.progress.blocked,
                        })}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      to="/kelola/onboarding/$employeeId"
                      params={{ employeeId: row.employee.id }}
                    >
                      {t("lifecycle.common.openDetail")}
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
