// Supervisor selfie sampling review (PRD v1.7 §3 F25; bead legend-0z5k).
// Today's outlet logs for the business date, flagged/rejected first; the
// supervisor opens one sample, checks the selfie evidence and the method/geo/
// device facts, then records "Sesuai" or "Tandai". The decision has no contract
// endpoint yet, so it lives in the session store (see review-store.ts).
import * as React from "react";
import { CalendarDays, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
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
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@starter/shared/i18n";
import type {
  AttendanceLog,
  AttendanceValidity,
  Employee,
} from "@starter/shared/hris";
import { useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { formatBusinessDate, formatOutletTime } from "../format.ts";
import {
  useAttendanceDay,
  useBusinessDate,
  useReviewDecisions,
  useReviewEmployees,
} from "../hooks.ts";
import {
  ATTENDANCE_METHOD_KEY,
  ATTENDANCE_TYPE_KEY,
  ATTENDANCE_VALIDITY,
  validityRank,
} from "../labels.ts";
import { useCanReviewAttendance } from "../guard.ts";
import { ATTENDANCE_TIME_ZONE } from "../outlet.ts";
import {
  decideAttendanceSample,
  type AttendanceReviewDecision,
  type AttendanceReviewKind,
  type AttendanceReviewState,
} from "../review-store.ts";
import { ReviewDialog } from "./review-dialog.tsx";

type ReviewRow = {
  log: AttendanceLog;
  employee: Employee | undefined;
  /** This session's decision; never applied to a rejected (terminal) log. */
  decision: AttendanceReviewDecision | undefined;
  /** The server's validity: the local decision never overrides it. */
  validity: AttendanceValidity;
};

function buildRows(
  logs: readonly AttendanceLog[],
  employees: readonly Employee[],
  decisions: AttendanceReviewState,
): ReviewRow[] {
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  return logs
    .map((log) => {
      // Session storage is not a source of truth: the row always shows the
      // server's validity, and a stored decision for a log the server has
      // since rejected is ignored.
      const decision =
        log.validity === "rejected" ? undefined : decisions[log.id];
      return {
        log,
        employee: byId.get(log.employeeId),
        decision,
        validity: log.validity,
      };
    })
    .sort(
      (left, right) =>
        validityRank(left.validity) - validityRank(right.validity) ||
        Date.parse(right.log.occurredAt) - Date.parse(left.log.occurredAt),
    );
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh review, so a
 * search or open sample of the previous outlet cannot carry over.
 */
export function SelfieReviewPage() {
  const { outlet } = useTenantContext();
  return <SelfieReviewContent key={outlet?.id ?? "none"} />;
}

function SelfieReviewContent() {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id;
  const businessDate = useBusinessDate();
  const logsQuery = useAttendanceDay(outletId, businessDate);
  const employeesQuery = useReviewEmployees();
  const decisions = useReviewDecisions(outletId, businessDate);
  const canDecide = useCanReviewAttendance();
  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const logs = React.useMemo(
    () => logsQuery.data?.data ?? [],
    [logsQuery.data],
  );
  const employees = React.useMemo(
    () => employeesQuery.data ?? [],
    [employeesQuery.data],
  );
  const rows = React.useMemo(
    () => buildRows(logs, employees, decisions),
    [logs, employees, decisions],
  );
  const term = search.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      term === ""
        ? rows
        : rows.filter((row) =>
            [row.employee?.fullName ?? "", row.employee?.employeeNo ?? ""]
              .join(" ")
              .toLowerCase()
              .includes(term),
          ),
    [rows, term],
  );

  // With no outlet the logs query is disabled and stays pending: show empty.
  const pending =
    outletId !== undefined && (logsQuery.isPending || employeesQuery.isPending);
  const failed = logsQuery.isError || employeesQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  const flagged = rows.filter((row) => row.validity === "flagged").length;
  const rejected = rows.filter((row) => row.validity === "rejected").length;
  const awaiting = rows.filter(
    (row) => row.validity === "flagged" && !row.decision,
  ).length;
  const reviewed = rows.filter((row) => row.decision !== undefined).length;

  const stat = (value: number) =>
    pending ? (
      <Skeleton className="h-8 w-20" />
    ) : failed ? (
      <span className="text-muted-foreground">
        {t("attendanceQr.common.noValue")}
      </span>
    ) : (
      formatNumber(value)
    );

  const selected = selectedId
    ? (rows.find((row) => row.log.id === selectedId) ?? null)
    : null;
  const employeeName = (row: ReviewRow | null) =>
    row?.employee?.fullName ?? t("attendanceQr.common.unknownEmployee");

  const retry = () => {
    void logsQuery.refetch();
    void employeesQuery.refetch();
  };

  const decide = (kind: AttendanceReviewKind) => {
    if (!canDecide || !selected || !outletId || businessDate === null) return;
    const decision = decideAttendanceSample({
      outletId,
      businessDate,
      log: selected.log,
      kind,
    });
    if (!decision) return;
    const name = employeeName(selected);
    toast({
      title:
        kind === "accepted"
          ? t("attendanceQr.review.acceptedToast", { name })
          : t("attendanceQr.review.flaggedToast", { name }),
      tone: kind === "accepted" ? "success" : "info",
    });
    setSelectedId(null);
  };

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="type-title">{t("attendanceQr.review.heading")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("attendanceQr.review.description")}
          </p>
        </div>
        {businessDate && (
          <Badge tone="neutral">
            <CalendarDays aria-hidden="true" />
            {t("attendanceQr.review.dateValue", {
              date: formatBusinessDate(businessDate),
            })}
          </Badge>
        )}
      </div>

      {!online && (
        <div
          role="status"
          className="flex flex-col items-start gap-1.5 rounded-container border-(length:--border-w) bg-warning-subtle p-card"
        >
          <StatusPill status="warning" icon={WifiOff}>
            {t("attendanceQr.review.offlineTitle")}
          </StatusPill>
          <p className="text-sm leading-5 text-warning">
            {t("attendanceQr.review.offlineHint")}
          </p>
        </div>
      )}

      <StatStrip label={t("attendanceQr.review.summaryLabel")}>
        <StatTile
          label={t("attendanceQr.review.statFlagged")}
          value={stat(flagged)}
          context={t("attendanceQr.review.statFlaggedContext", {
            count: flagged,
          })}
        />
        <StatTile
          label={t("attendanceQr.review.statPending")}
          value={stat(awaiting)}
          context={t("attendanceQr.review.statPendingContext")}
        />
        <StatTile
          label={t("attendanceQr.review.statReviewed")}
          value={stat(reviewed)}
          context={
            pending || failed
              ? undefined
              : t("attendanceQr.review.statReviewedContext", {
                  reviewed,
                  total: rows.length,
                })
          }
        />
        <StatTile
          label={t("attendanceQr.review.statRejected")}
          value={stat(rejected)}
          context={t("attendanceQr.review.statRejectedContext")}
        />
      </StatStrip>

      <DataTableShell
        title={t("attendanceQr.review.tableTitle")}
        description={t("attendanceQr.review.tableDescription")}
        state={state}
        onRetry={retry}
        search={{
          value: search,
          onChange: setSearch,
          label: t("attendanceQr.review.searchLabel"),
        }}
        empty={{
          title: t("attendanceQr.review.emptyTitle"),
          description: t("attendanceQr.review.emptyHint"),
        }}
        noResults={rows.length > 0 && filtered.length === 0}
        rowCount={filtered.length}
        loadingRows={8}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("attendanceQr.review.columns.employee")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.time")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.type")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.method")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.validity")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.selfie")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.decision")}</TableHead>
              <TableHead>{t("attendanceQr.review.columns.action")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => {
              const status = ATTENDANCE_VALIDITY[row.validity];
              return (
                <TableRow key={row.log.id}>
                  <TableCell className="min-w-44">
                    <span className="block font-medium">
                      {employeeName(row)}
                    </span>
                    {row.employee && (
                      <span className="block text-xs text-muted-foreground">
                        {row.employee.employeeNo}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatOutletTime(row.log.occurredAt, ATTENDANCE_TIME_ZONE)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t(ATTENDANCE_TYPE_KEY[row.log.type])}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t(ATTENDANCE_METHOD_KEY[row.log.method])}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={status.status}>
                      {t(status.labelKey)}
                    </StatusPill>
                  </TableCell>
                  <TableCell>
                    {row.log.photoUrl === null ? (
                      <span className="text-muted-foreground">
                        {t("attendanceQr.review.selfieMissing")}
                      </span>
                    ) : (
                      <Badge tone="info">
                        {t("attendanceQr.review.selfiePresent")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.decision ? (
                      <Badge
                        tone={
                          row.decision.kind === "accepted"
                            ? "success"
                            : "warning"
                        }
                      >
                        {row.decision.kind === "accepted"
                          ? t("attendanceQr.review.localAccepted")
                          : t("attendanceQr.review.localFlagged")}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("attendanceQr.review.decisionPending")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedId(row.log.id)}
                    >
                      {row.decision
                        ? t("attendanceQr.review.reviewAgainAction")
                        : t("attendanceQr.review.reviewAction")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      <ReviewDialog
        log={selected?.log ?? null}
        employeeName={employeeName(selected)}
        decision={selected?.decision}
        canDecide={canDecide}
        onDecide={decide}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
