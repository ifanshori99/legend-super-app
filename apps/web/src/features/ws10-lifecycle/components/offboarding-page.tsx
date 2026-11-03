// Offboarding list (PRD v1.7 §3 D26 "Offboarding": resign or termination with
// an exit clearance). Rows are the employees leaving the tenant plus anyone who
// already has an offboarding task, with their exit date and clearance progress.
//
// No tenant-wide checklist endpoint exists yet, so the screen asks each
// candidate employee for its offboarding tasks (see hooks.ts); the clearance
// state is the contract's own rule (`isChecklistComplete`).
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
  offboardingCandidates,
  positionName,
  type ChecklistProgress,
} from "../lib.ts";
import { MetricValue } from "./metric-value.tsx";

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
  clearanceDone: boolean;
};

export function OffboardingPage() {
  const t = useT();
  const [search, setSearch] = React.useState("");

  const directory = useEmployeeDirectory();
  const positions = usePositions();
  const allEmployees = React.useMemo(
    () => directory.data?.data ?? [],
    [directory.data],
  );
  // The exit list cannot know who has offboarding tasks without asking each
  // employee: the contract lists checklist tasks per employee only.
  const checklists = useChecklistTasksForEmployees(
    allEmployees.map((employee) => employee.id),
    "offboarding",
  );
  const candidates = React.useMemo(
    () => offboardingCandidates(allEmployees, checklists.tasks),
    [allEmployees, checklists.tasks],
  );

  const rows = React.useMemo<Row[]>(() => {
    const visible: Row[] = [];
    for (const employee of candidates) {
      if (!matchesSearch(employee, search)) continue;
      const tasks = checklists.tasks.get(employee.id) ?? [];
      visible.push({
        employee,
        progress: checklistProgress(tasks),
        clearanceDone: clearanceComplete(tasks),
      });
    }
    return visible.sort(
      (left, right) =>
        (left.employee.endDate ?? "").localeCompare(
          right.employee.endDate ?? "",
        ) ||
        left.employee.fullName.localeCompare(right.employee.fullName, "id-ID"),
    );
  }, [candidates, checklists.tasks, search]);

  const totals = React.useMemo(() => {
    const progress = rows.map((row) => row.progress);
    return {
      employees: rows.length,
      done: progress.reduce((sum, row) => sum + row.complete, 0),
      open: progress.reduce((sum, row) => sum + row.open, 0),
      blocked: progress.reduce((sum, row) => sum + row.blocked, 0),
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
        label={t("lifecycle.offboarding.list.metricsLabel")}
        columns={4}
      >
        <StatTile
          label={t("lifecycle.offboarding.list.metrics.employees")}
          value={<MetricValue state={state} value={totals.employees} />}
          context={t("lifecycle.offboarding.list.metricsContext")}
        />
        <StatTile
          label={t("lifecycle.offboarding.list.metrics.done")}
          value={<MetricValue state={state} value={totals.done} />}
        />
        <StatTile
          label={t("lifecycle.offboarding.list.metrics.open")}
          value={<MetricValue state={state} value={totals.open} />}
        />
        <StatTile
          label={t("lifecycle.offboarding.list.metrics.blocked")}
          value={<MetricValue state={state} value={totals.blocked} />}
        />
      </StatStrip>

      <DataTableShell
        title={t("lifecycle.offboarding.list.title")}
        description={t("lifecycle.offboarding.list.description")}
        state={state}
        onRetry={retry}
        search={{
          value: search,
          onChange: setSearch,
          label: t("lifecycle.offboarding.list.search"),
        }}
        noResults={state === "ready" && rows.length === 0}
        rowCount={
          state === "ready" && rows.length > 0 ? rows.length : undefined
        }
        empty={{
          title: t("lifecycle.offboarding.list.empty"),
          description: t("lifecycle.offboarding.list.emptyHint"),
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("lifecycle.offboarding.list.columns.employee")}
              </TableHead>
              <TableHead>
                {t("lifecycle.offboarding.list.columns.position")}
              </TableHead>
              <TableHead>
                {t("lifecycle.offboarding.list.columns.exit")}
              </TableHead>
              <TableHead>
                {t("lifecycle.offboarding.list.columns.clearance")}
              </TableHead>
              <TableHead>
                {t("lifecycle.offboarding.list.columns.status")}
              </TableHead>
              <TableHead className="text-right">
                {t("lifecycle.offboarding.list.columns.open")}
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
                <TableCell className="tabular whitespace-nowrap">
                  {row.employee.endDate === null
                    ? t("lifecycle.common.noValue")
                    : formatBusinessDate(row.employee.endDate)}
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
                <TableCell>
                  {row.progress.total === 0 ? (
                    <Badge tone="neutral">
                      {t("lifecycle.offboarding.list.clearance.none")}
                    </Badge>
                  ) : row.clearanceDone ? (
                    <Badge tone="success">
                      {t("lifecycle.offboarding.list.clearance.done")}
                    </Badge>
                  ) : (
                    <Badge tone="info">
                      {t("lifecycle.offboarding.list.clearance.running")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      to="/kelola/offboarding/$employeeId"
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
