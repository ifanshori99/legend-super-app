// The roster's working surface: employees (rows) × seven business days
// (columns), with shift chips, HTML5 drag-and-drop from the template palette,
// a keyboard/touch alternative in each cell menu, and the contract's
// compliance warnings inline (PRD v1.7 §3 Kelompok D 28 "Roster Mingguan",
// F26 "Kepatuhan", HR-05).
import * as React from "react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type {
  Employee,
  Holiday,
  ShiftAssignment,
  ShiftComplianceIssue,
  ShiftTemplate,
} from "@starter/shared/hris";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { stationName } from "../fixtures";
import {
  complianceMessageKey,
  formatDayLabel,
  formatShiftRange,
  formatTemplateSegments,
  totalWorkedMinutes,
  type WeekCompliance,
} from "../lib";

const CHIP_TONE = {
  draft: "warning",
  published: "success",
  swapped: "info",
  cancelled: "neutral",
} as const;

const CHIP_LABEL = {
  draft: "roster.chip.draft",
  published: "roster.chip.published",
  swapped: "roster.chip.swapped",
  cancelled: "roster.chip.draft",
} as const;

function ShiftChip({
  assignment,
  positionLabel,
  issues,
}: {
  assignment: ShiftAssignment;
  positionLabel: string;
  issues: readonly ShiftComplianceIssue[];
}) {
  const t = useT();
  const station = stationName(assignment.stationId);
  const context = station ? `${positionLabel} · ${station}` : positionLabel;
  return (
    <li className="grid gap-1 rounded-md border-(length:--border-w) bg-card p-1.5 text-xs shadow-hairline">
      <div className="flex items-start justify-between gap-1">
        <span className="font-semibold tabular">
          {formatShiftRange(assignment)}
        </span>
        <Badge tone={CHIP_TONE[assignment.status]}>
          {t(CHIP_LABEL[assignment.status])}
        </Badge>
      </div>
      <p className="truncate text-muted-foreground">{context}</p>
      {issues.map((issue) => (
        <p
          key={`${issue.code}|${issue.relatedAssignmentId ?? ""}|${issue.actual}`}
          className="flex items-start gap-1 font-medium text-danger"
        >
          <TriangleAlert
            className="mt-0.5 size-3 shrink-0"
            aria-hidden="true"
          />
          {t(complianceMessageKey(issue.code), {
            actual: issue.actual,
            limit: issue.limit,
          })}
        </p>
      ))}
    </li>
  );
}

function CellMenu({
  employee,
  day,
  drafts,
  templates,
  onAssign,
  onRemoveDraft,
}: {
  employee: Employee;
  day: string;
  drafts: readonly ShiftAssignment[];
  templates: readonly ShiftTemplate[];
  onAssign: (
    employeeId: string,
    businessDate: string,
    templateId: string,
  ) => void;
  onRemoveDraft: (assignmentId: string) => void;
}) {
  const t = useT();
  if (templates.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("roster.grid.addFor", {
            employee: employee.fullName,
            date: formatDayLabel(day),
          })}
          className="relative inline-grid size-7 place-items-center after:absolute after:-inset-2 after:content-[''] rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>
          {t("roster.grid.menuLabel", {
            employee: employee.fullName,
            date: formatDayLabel(day),
          })}
        </DropdownMenuLabel>
        {templates.map((template) => (
          <DropdownMenuItem
            key={template.id}
            onSelect={() => onAssign(employee.id, day, template.id)}
          >
            {t("roster.grid.addTemplate", {
              template: `${template.name} · ${formatTemplateSegments(template)}`,
            })}
          </DropdownMenuItem>
        ))}
        {drafts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {drafts.map((draft) => (
              <DropdownMenuItem
                key={draft.id}
                destructive
                onSelect={() => onRemoveDraft(draft.id)}
              >
                <Trash2 aria-hidden="true" />
                {t("roster.grid.removeDraft", {
                  time: formatShiftRange(draft),
                })}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DayCell({
  employee,
  day,
  assignments,
  drafts,
  templates,
  positionLabel,
  issuesByAssignment,
  onAssign,
  onRemoveDraft,
}: {
  employee: Employee;
  day: string;
  assignments: readonly ShiftAssignment[];
  drafts: readonly ShiftAssignment[];
  templates: readonly ShiftTemplate[];
  positionLabel: string;
  issuesByAssignment: Map<string, ShiftComplianceIssue[]>;
  onAssign: (
    employeeId: string,
    businessDate: string,
    templateId: string,
  ) => void;
  onRemoveDraft: (assignmentId: string) => void;
}) {
  const [over, setOver] = React.useState(false);
  return (
    <TableCell
      className={cn(
        "min-w-32 px-1.5 py-1.5 align-top transition-colors",
        over && "bg-primary-tint",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const templateId = event.dataTransfer.getData("text/plain");
        if (templateId) onAssign(employee.id, day, templateId);
      }}
    >
      <div className="grid gap-1">
        {assignments.length > 0 && (
          <ul
            className="grid gap-1"
            aria-label={`${employee.fullName}, ${formatDayLabel(day)}`}
          >
            {assignments.map((assignment) => (
              <ShiftChip
                key={assignment.id}
                assignment={assignment}
                positionLabel={positionLabel}
                issues={issuesByAssignment.get(assignment.id) ?? []}
              />
            ))}
          </ul>
        )}
        <CellMenu
          employee={employee}
          day={day}
          drafts={drafts}
          templates={templates}
          onAssign={onAssign}
          onRemoveDraft={onRemoveDraft}
        />
      </div>
    </TableCell>
  );
}

export type WeekGridProps = {
  days: readonly string[];
  employees: readonly Employee[];
  rows: readonly ShiftAssignment[];
  positions: ReadonlyMap<string, string>;
  holidays: readonly Holiday[];
  templates: readonly ShiftTemplate[];
  compliance: WeekCompliance;
  today: string;
  /** Filter controls rendered in the card header (position, station). */
  toolbar?: React.ReactNode;
  onAssign: (
    employeeId: string,
    businessDate: string,
    templateId: string,
  ) => void;
  onRemoveDraft: (assignmentId: string) => void;
};

export function WeekGrid({
  days,
  employees,
  rows,
  positions,
  holidays,
  templates,
  compliance,
  today,
  toolbar,
  onAssign,
  onRemoveDraft,
}: WeekGridProps) {
  const t = useT();
  const holidayByDate = new Map(
    holidays.map((holiday) => [holiday.date, holiday]),
  );
  const rowsByEmployee = new Map<string, ShiftAssignment[]>();
  for (const row of rows) {
    const list = rowsByEmployee.get(row.employeeId) ?? [];
    list.push(row);
    rowsByEmployee.set(row.employeeId, list);
  }
  const activeTemplates = templates.filter((template) => template.isActive);
  const hasAnyShift = rows.length > 0;

  return (
    <CardShell>
      <CardShellBody>
        <header className="flex flex-col gap-3 border-b-(length:--border-w) p-card lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-1">
            <h2 className="type-title">{t("roster.grid.title")}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("roster.grid.description")}
            </p>
          </div>
          {toolbar}
        </header>
        <Table className="min-w-[60rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-20 bg-card">
                {t("roster.grid.employee")}
              </TableHead>
              {days.map((day) => {
                const holiday = holidayByDate.get(day);
                const isToday = day === today;
                return (
                  <TableHead
                    key={day}
                    aria-current={isToday ? "date" : undefined}
                    className={cn("min-w-32", isToday && "bg-surface-2")}
                  >
                    <span className="block font-semibold text-foreground">
                      {formatDayLabel(day)}
                    </span>
                    {isToday && (
                      <span className="text-xs text-muted-foreground">
                        {t("roster.grid.today")}
                      </span>
                    )}
                    {holiday && (
                      <Badge tone="info" className="mt-1">
                        {t("roster.grid.holiday")}
                      </Badge>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees.map((employee) => {
              const employeeRows = rowsByEmployee.get(employee.id) ?? [];
              const positionLabel =
                (employee.positionId !== null
                  ? positions.get(employee.positionId)
                  : null) ?? t("roster.grid.noPosition");
              const issueCount = employeeRows.reduce(
                (sum, row) =>
                  sum + (compliance.byAssignment.get(row.id)?.length ?? 0),
                0,
              );
              return (
                <TableRow key={employee.id}>
                  {/* Row header: screen readers announce the employee for
                      every day cell in this row. */}
                  <TableCell
                    role="rowheader"
                    className="sticky left-0 z-10 min-w-44 bg-card align-top"
                  >
                    <div className="grid gap-1 py-1">
                      <p className="font-semibold">{employee.fullName}</p>
                      <p className="text-sm text-muted-foreground">
                        {positionLabel} · {employee.employeeNo}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="tabular">
                          {t("roster.grid.totalHours", {
                            hours: formatNumber(
                              Math.round(totalWorkedMinutes(employeeRows) / 60),
                            ),
                          })}
                        </span>
                        {issueCount > 0 && (
                          <span className="inline-flex items-center gap-1 font-semibold text-danger">
                            <TriangleAlert
                              className="size-3.5"
                              aria-hidden="true"
                            />
                            {t("roster.grid.rowWarnings", {
                              count: issueCount,
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  {days.map((day) => {
                    const assignments = employeeRows.filter(
                      (row) => row.businessDate === day,
                    );
                    const drafts = assignments.filter(
                      (row) => row.status === "draft",
                    );
                    return (
                      <DayCell
                        key={`${employee.id}|${day}`}
                        employee={employee}
                        day={day}
                        assignments={assignments}
                        drafts={drafts}
                        templates={activeTemplates}
                        positionLabel={positionLabel}
                        issuesByAssignment={compliance.byAssignment}
                        onAssign={onAssign}
                        onRemoveDraft={onRemoveDraft}
                      />
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!hasAnyShift && (
          <p className="border-t-(length:--border-w) p-card text-sm text-muted-foreground">
            {t("roster.grid.emptyWeek")}
          </p>
        )}
      </CardShellBody>
    </CardShell>
  );
}
