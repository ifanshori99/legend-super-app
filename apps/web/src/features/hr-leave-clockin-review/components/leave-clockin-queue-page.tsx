// HR queue of attendance logged on an approved leave day (bead legend-3jem1,
// states 1, 9 and 10). Desktop shows a table, mobile readable cards. A case
// whose leave was approved after the clock-in is flagged "Perlu ditinjau
// ulang" with its own note. The decision happens on the detail page.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  CalendarOff,
  Clock,
  PencilLine,
  RefreshCw,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { formatBusinessDate } from "../../ws10-attendance-qr/format.ts";
import { ATTENDANCE_TIME_ZONE } from "../../ws10-attendance-qr/outlet.ts";
import { formatClockMinutes } from "../format.ts";
import { useLeaveClockinCases } from "../hooks.ts";
import type { MessageKey } from "@starter/shared/i18n";
import type { LeaveClockinCase, LeaveClockinCaseKind } from "../types.ts";

const KIND_PILL: Record<
  LeaveClockinCaseKind,
  { labelKey: MessageKey; icon: LucideIcon }
> = {
  clock_in_on_leave: {
    labelKey: "leaveClockinReview.status.leaveClockIn",
    icon: CalendarOff,
  },
  manual_correction: {
    labelKey: "leaveClockinReview.status.manualCorrection",
    icon: PencilLine,
  },
  re_review: {
    labelKey: "leaveClockinReview.status.reReview",
    icon: RefreshCw,
  },
};

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh queue, so a
 * search typed for the previous outlet cannot carry over.
 */
export function LeaveClockinQueuePage() {
  const { outlet } = useTenantContext();
  return <LeaveClockinQueueContent key={outlet?.id ?? "none"} />;
}

function LeaveClockinQueueContent() {
  const t = useT();
  const online = useOnline();
  const query = useLeaveClockinCases();
  const [search, setSearch] = React.useState("");

  const cases = React.useMemo(() => query.data ?? [], [query.data]);
  const term = search.trim().toLowerCase();
  const unknownEmployee = t("attendanceQr.common.unknownEmployee");
  const filtered = React.useMemo(
    () =>
      term === ""
        ? cases
        : cases.filter((item) =>
            (item.employeeName ?? unknownEmployee).toLowerCase().includes(term),
          ),
    [cases, term, unknownEmployee],
  );

  const failed = query.isError && query.data === undefined;
  const state: DataState = query.isPending
    ? "loading"
    : failed
      ? "ready"
      : cases.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-5">
      <div className="grid min-w-0 gap-1">
        <h2 className="type-title">{t("leaveClockinReview.queue.title")}</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("leaveClockinReview.queue.description")}
        </p>
      </div>

      {!online && (
        <div
          role="status"
          className="flex flex-col items-start gap-1.5 rounded-container border-(length:--border-w) bg-warning-subtle p-card"
        >
          <StatusPill status="warning" icon={WifiOff}>
            {t("leaveClockinReview.offline.title")}
          </StatusPill>
          <p className="text-sm leading-5 text-warning">
            {t("leaveClockinReview.offline.description")}
          </p>
        </div>
      )}

      <DataTableShell
        title={t("leaveClockinReview.queue.sectionTitle")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("leaveClockinReview.queue.searchLabel"),
        }}
        empty={{
          title: t("leaveClockinReview.empty.title"),
          description: t("leaveClockinReview.empty.description"),
        }}
        noResults={!failed && cases.length > 0 && filtered.length === 0}
        rowCount={failed ? undefined : filtered.length}
        loadingRows={4}
      >
        {failed ? (
          <ErrorState
            title={t("leaveClockinReview.error.title")}
            description={t("leaveClockinReview.error.description")}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <QueueTable cases={filtered} unknownEmployee={unknownEmployee} />
            </div>
            <ul
              className="grid gap-3 p-card md:hidden"
              aria-label={t("leaveClockinReview.queue.tableLabel")}
            >
              {filtered.map((item) => (
                <li key={item.logId}>
                  <QueueCard item={item} unknownEmployee={unknownEmployee} />
                </li>
              ))}
            </ul>
          </>
        )}
      </DataTableShell>
    </div>
  );
}

function KindPill({ kind }: { kind: LeaveClockinCaseKind }) {
  const t = useT();
  const { labelKey, icon } = KIND_PILL[kind];
  return (
    <StatusPill
      status={kind === "re_review" ? "warning" : "info"}
      icon={icon}
      className="whitespace-nowrap"
    >
      {t(labelKey)}
    </StatusPill>
  );
}

function ClockOut({ item }: { item: LeaveClockinCase }) {
  const t = useT();
  return item.clockOutAt === null ? (
    <span className="text-muted-foreground">
      {t("leaveClockinReview.queue.clockOutMissing")}
    </span>
  ) : (
    <span className="tabular">
      {formatClockMinutes(item.clockOutAt, ATTENDANCE_TIME_ZONE)}
    </span>
  );
}

function ReviewLink({
  item,
  employee,
  className,
}: {
  item: LeaveClockinCase;
  employee: string;
  className?: string;
}) {
  const t = useT();
  return (
    <Button asChild className={className}>
      <Link
        to="/kelola/absensi/tinjauan-cuti/$logId"
        params={{ logId: item.logId }}
        aria-label={t("leaveClockinReview.queue.reviewFor", {
          employee,
          date: formatBusinessDate(item.businessDate),
        })}
      >
        {t("leaveClockinReview.queue.review")}
      </Link>
    </Button>
  );
}

function QueueTable({
  cases,
  unknownEmployee,
}: {
  cases: readonly LeaveClockinCase[];
  unknownEmployee: string;
}) {
  const t = useT();
  return (
    <Table aria-label={t("leaveClockinReview.queue.tableLabel")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("leaveClockinReview.queue.columnStatus")}</TableHead>
          <TableHead>{t("leaveClockinReview.queue.columnEmployee")}</TableHead>
          <TableHead>{t("leaveClockinReview.queue.columnDate")}</TableHead>
          <TableHead>{t("leaveClockinReview.queue.columnLeave")}</TableHead>
          <TableHead>{t("leaveClockinReview.queue.columnClockIn")}</TableHead>
          <TableHead>{t("leaveClockinReview.queue.columnClockOut")}</TableHead>
          <TableHead>{t("leaveClockinReview.queue.columnAction")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cases.map((item) => {
          const employee = item.employeeName ?? unknownEmployee;
          return (
            <TableRow key={item.logId}>
              <TableCell>
                <div className="grid justify-items-start gap-1.5">
                  <KindPill kind={item.kind} />
                  {item.kind === "re_review" && (
                    <span className="max-w-56 text-xs leading-4 text-warning">
                      {t("leaveClockinReview.reReview.note")}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="min-w-40 font-medium">{employee}</TableCell>
              <TableCell className="tabular whitespace-nowrap">
                {formatBusinessDate(item.businessDate)}
              </TableCell>
              <TableCell>{item.leave?.typeName ?? "–"}</TableCell>
              <TableCell className="tabular whitespace-nowrap">
                {formatClockMinutes(item.clockInAt, ATTENDANCE_TIME_ZONE)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <ClockOut item={item} />
              </TableCell>
              <TableCell>
                <ReviewLink item={item} employee={employee} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function QueueCard({
  item,
  unknownEmployee,
}: {
  item: LeaveClockinCase;
  unknownEmployee: string;
}) {
  const t = useT();
  const employee = item.employeeName ?? unknownEmployee;
  return (
    <article className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
      <div className="grid justify-items-start gap-1.5">
        <KindPill kind={item.kind} />
        {item.kind === "re_review" && (
          <p className="text-sm leading-5 text-warning">
            {t("leaveClockinReview.reReview.note")}
          </p>
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="text-base leading-6 font-semibold">{employee}</h3>
        <p className="tabular text-sm leading-5">
          {formatBusinessDate(item.businessDate)}
        </p>
        {item.leave?.typeName && (
          <p className="text-sm leading-5 text-muted-foreground">
            {item.leave.typeName}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 border-t pt-3 text-sm">
        <div className="flex items-start gap-2">
          <Clock
            className="mt-0.5 size-icon text-muted-foreground"
            aria-hidden="true"
          />
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">
              {t("leaveClockinReview.queue.clockInLabel")}
            </dt>
            <dd className="tabular font-semibold">
              {formatClockMinutes(item.clockInAt, ATTENDANCE_TIME_ZONE)}
            </dd>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Clock
            className="mt-0.5 size-icon text-muted-foreground"
            aria-hidden="true"
          />
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">
              {t("leaveClockinReview.queue.clockOutLabel")}
            </dt>
            <dd className="font-semibold">
              <ClockOut item={item} />
            </dd>
          </div>
        </div>
      </dl>
      <ReviewLink item={item} employee={employee} className="min-h-11 w-full" />
    </article>
  );
}
