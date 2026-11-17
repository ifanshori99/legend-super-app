// THR schedules (PRD §3 F30 "THR"; contract `thr_schedules`). A schedule names
// the holiday, the tenure reference date and the pay date; the proration rule
// itself is a versioned statutory table (type `thr`), so this tab reads the
// published version and states it next to the list.
import * as React from "react";
import { CalendarClock, CircleCheck, CircleSlash, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type {
  ThrSchedule,
  ThrScheduleStatus,
} from "@starter/shared/hris/payroll";
import { isOffline } from "../errors";
import { useStatutoryTables, useThrSchedules } from "../hooks";
import {
  businessDateToday,
  filterThrSchedules,
  formatBusinessDate,
  publishedVersionOf,
  thrYear,
} from "../lib";
import { ThrDialog } from "./thr-dialog";
import { PayrollOfflineState } from "./payroll-offline-state";

function ThrStatusPill({ status }: { status: ThrScheduleStatus }) {
  const t = useT();
  if (status === "paid")
    return (
      <StatusPill status="success" icon={CircleCheck}>
        {t("payrollConfig.thrStatus.paid")}
      </StatusPill>
    );
  if (status === "cancelled")
    return (
      <StatusPill status="delivered" icon={CircleSlash}>
        {t("payrollConfig.thrStatus.cancelled")}
      </StatusPill>
    );
  return (
    <StatusPill status="info" icon={CalendarClock}>
      {t("payrollConfig.thrStatus.scheduled")}
    </StatusPill>
  );
}

function scopeLabel(schedule: ThrSchedule, t: ReturnType<typeof useT>): string {
  return schedule.employeeIds === null
    ? t("payrollConfig.thr.scope.all")
    : t("payrollConfig.thr.scope.selected", {
        count: schedule.employeeIds.length,
      });
}

export function ThrTab({ canRun }: { canRun: boolean }) {
  const t = useT();
  const schedulesQuery = useThrSchedules();
  const statutoryQuery = useStatutoryTables();

  const [search, setSearch] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const schedules = schedulesQuery.data?.data ?? [];
  const versions = statutoryQuery.data?.data ?? [];
  const thrRule = publishedVersionOf(versions, "thr", businessDateToday());
  const rows = filterThrSchedules(schedules, search);

  const defaultLegalEntityId = schedules[0]?.legalEntityId ?? null;

  const scheduled = schedules.filter(
    (schedule) => schedule.status === "scheduled",
  ).length;
  const paid = schedules.filter(
    (schedule) => schedule.status === "paid",
  ).length;

  // Counts and the rule are only real once their query succeeded: while
  // loading or failed they read as a dash / skeleton, never as a 0.
  const metric = (value: number) => (schedulesQuery.isSuccess ? value : "—");

  if (schedulesQuery.isError && isOffline(schedulesQuery.error))
    return (
      <PayrollOfflineState onRetry={() => void schedulesQuery.refetch()} />
    );

  return (
    <>
      <StatStrip label={t("payrollConfig.thr.metrics.label")}>
        <StatTile
          label={t("payrollConfig.thr.metrics.schedules")}
          value={metric(schedules.length)}
        />
        <StatTile
          label={t("payrollConfig.thr.metrics.scheduled")}
          value={metric(scheduled)}
        />
        <StatTile
          label={t("payrollConfig.thr.metrics.paid")}
          value={metric(paid)}
        />
        <StatTile
          label={t("payrollConfig.thr.metrics.fullTenure")}
          // No published THR rule: show a dash, never an invented 0.
          value={
            statutoryQuery.isPending ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              (thrRule?.parameters.fullTenureMonths ?? "—")
            )
          }
        />
      </StatStrip>

      <CardShell>
        <Card>
          <CardHeader>
            <CardTitle>{t("payrollConfig.thr.ruleTitle")}</CardTitle>
            {/* Skeleton is a <div>: keep it out of the <p> CardDescription. */}
            {statutoryQuery.isPending ? (
              <Skeleton className="h-5 w-3/4" />
            ) : (
              <CardDescription>
                {!statutoryQuery.isSuccess
                  ? "—"
                  : thrRule
                    ? t("payrollConfig.thr.ruleBody", {
                        min: thrRule.parameters.minTenureMonths,
                        full: thrRule.parameters.fullTenureMonths,
                      })
                    : t("payrollConfig.thr.ruleNone")}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("payrollConfig.thr.form.tenureHint")}
            </p>
          </CardContent>
        </Card>
      </CardShell>

      <DataTableShell
        title={t("payrollConfig.thr.title")}
        description={t("payrollConfig.thr.description")}
        state={
          schedulesQuery.isPending
            ? "loading"
            : schedulesQuery.isError
              ? "error"
              : schedules.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("payrollConfig.thr.searchLabel"),
        }}
        actions={
          <Button
            type="button"
            onClick={() => setCreating(true)}
            disabled={!canRun}
            title={!canRun ? t("payrollConfig.readOnlyHint") : undefined}
          >
            <Plus aria-hidden="true" />
            {t("payrollConfig.thr.add")}
          </Button>
        }
        error={schedulesQuery.error}
        onRetry={() => void schedulesQuery.refetch()}
        empty={{
          title: t("payrollConfig.thr.emptyTitle"),
          description: t("payrollConfig.thr.emptyHint"),
        }}
        noResults={schedules.length > 0 && rows.length === 0}
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("payrollConfig.thr.columns.schedule")}</TableHead>
                <TableHead>{t("payrollConfig.thr.columns.holiday")}</TableHead>
                <TableHead>
                  {t("payrollConfig.thr.columns.tenureAsOf")}
                </TableHead>
                <TableHead>{t("payrollConfig.thr.columns.payDate")}</TableHead>
                <TableHead>{t("payrollConfig.thr.columns.scope")}</TableHead>
                <TableHead>{t("payrollConfig.thr.columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((schedule) => (
                <TableRow key={schedule.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-semibold">{schedule.name}</span>
                      <span className="text-sm text-muted-foreground tabular">
                        {thrYear(schedule)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span>{schedule.holidayName}</span>
                      <span className="text-sm text-muted-foreground tabular">
                        {formatBusinessDate(schedule.holidayDate)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular">
                    {formatBusinessDate(schedule.tenureAsOfDate)}
                  </TableCell>
                  <TableCell className="tabular">
                    {formatBusinessDate(schedule.payDate)}
                  </TableCell>
                  <TableCell>{scopeLabel(schedule, t)}</TableCell>
                  <TableCell>
                    <ThrStatusPill status={schedule.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {rows.map((schedule) => (
            <li
              key={schedule.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-semibold">{schedule.name}</span>
                  <span className="text-sm text-muted-foreground tabular">
                    {thrYear(schedule)}
                  </span>
                </div>
                <ThrStatusPill status={schedule.status} />
              </div>
              <p className="text-sm">
                {schedule.holidayName}
                {" · "}
                <span className="tabular">
                  {formatBusinessDate(schedule.holidayDate)}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t("payrollConfig.thr.columns.tenureAsOf")}
                {": "}
                <span className="tabular">
                  {formatBusinessDate(schedule.tenureAsOfDate)}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t("payrollConfig.thr.columns.payDate")}
                {": "}
                <span className="tabular">
                  {formatBusinessDate(schedule.payDate)}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {scopeLabel(schedule, t)}
              </p>
            </li>
          ))}
        </ul>
      </DataTableShell>

      {creating && (
        <ThrDialog
          defaultLegalEntityId={defaultLegalEntityId}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
