// Saved reports and their email schedules (PRD v1.7 §3 F36 "simpan",
// "jadwalkan"). A saved report is private to its owner (the contract's safest
// default). Each row can be opened back into the builder, scheduled, archived;
// its schedules can be paused and resumed. Loading, empty, error and offline
// are separate states.
import { useState } from "react";
import {
  Archive,
  CalendarClock,
  FolderOpen,
  RotateCcw,
  WifiOff,
} from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { ReportSchedule, SavedReport } from "@starter/shared/dashboard";
import { isOfflineError } from "../builder";
import { dimensionLabel, formatDateTime, reportErrorText } from "../format";
import {
  useReportSchedules,
  useSavedReports,
  useUpdateSavedReport,
  useUpdateSchedule,
} from "../hooks";
import { ScheduleDialog } from "./schedule-dialog";
import { StepCard } from "./step-card";

function scheduleSummary(
  schedule: ReportSchedule,
  t: ReturnType<typeof useT>,
): string {
  const when =
    schedule.frequency === "weekly" && schedule.dayOfWeek !== null
      ? t("reportBuilder.schedule.summaryWeekly", {
          day: t(`reportBuilder.weekdays.${schedule.dayOfWeek}` as MessageKey),
          time: schedule.timeOfDay,
        })
      : schedule.frequency === "monthly" && schedule.dayOfMonth !== null
        ? t("reportBuilder.schedule.summaryMonthly", {
            day: schedule.dayOfMonth,
            time: schedule.timeOfDay,
          })
        : t("reportBuilder.schedule.summaryDaily", {
            time: schedule.timeOfDay,
          });
  return t("reportBuilder.schedule.summary", {
    when,
    format: t(`reportBuilder.schedule.formats.${schedule.format}`),
    count: schedule.recipients.length,
  });
}

function ScheduleRow({ schedule }: { schedule: ReportSchedule }) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateSchedule();
  const toggle = (isEnabled: boolean) =>
    update.mutate(
      {
        id: schedule.id,
        input: {
          frequency: schedule.frequency,
          timeOfDay: schedule.timeOfDay,
          dayOfWeek: schedule.dayOfWeek,
          dayOfMonth: schedule.dayOfMonth,
          format: schedule.format,
          recipients: schedule.recipients,
          isEnabled,
        },
      },
      {
        onSuccess: () =>
          toast({
            title: t(
              isEnabled
                ? "reportBuilder.schedule.resumed"
                : "reportBuilder.schedule.paused",
            ),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("reportBuilder.schedule.updateFailed"),
            description: reportErrorText(t, error),
            tone: "danger",
          }),
      },
    );
  const switchId = `schedule-${schedule.id}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-control bg-surface-2 px-3 py-2">
      <div className="grid min-w-0 gap-0.5">
        <p className="text-sm leading-5">{scheduleSummary(schedule, t)}</p>
        <p className="text-xs leading-5 text-muted-foreground tabular">
          {schedule.isEnabled && schedule.nextRunAt
            ? t("reportBuilder.schedule.nextRun", {
                time: formatDateTime(schedule.nextRunAt),
              })
            : t("reportBuilder.schedule.pausedLabel")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor={switchId} className="text-sm">
          {schedule.isEnabled
            ? t("reportBuilder.schedule.active")
            : t("reportBuilder.schedule.pausedLabel")}
        </Label>
        <Switch
          id={switchId}
          checked={schedule.isEnabled}
          disabled={update.isPending}
          onCheckedChange={toggle}
          aria-label={t("reportBuilder.schedule.toggleLabel")}
        />
      </div>
    </li>
  );
}

function SavedRow({
  report,
  schedules,
  isLoaded,
  onOpen,
  onSchedule,
}: {
  report: SavedReport;
  schedules: readonly ReportSchedule[];
  isLoaded: boolean;
  onOpen: () => void;
  onSchedule: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateSavedReport();
  const archived = report.status === "archived";
  const summary = [
    t("reportBuilder.saved.metricCount", {
      count: report.query.metricCodes.length,
    }),
    ...report.query.groupBy.map((key) => dimensionLabel(t, key)),
  ].join(" · ");

  const setStatus = () =>
    update.mutate(
      {
        id: report.id,
        input: { status: archived ? "active" : "archived" },
      },
      {
        onSuccess: () =>
          toast({
            title: t(
              archived
                ? "reportBuilder.saved.restored"
                : "reportBuilder.saved.archived",
              { name: report.name },
            ),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("reportBuilder.saved.updateFailed"),
            description: reportErrorText(t, error),
            tone: "danger",
          }),
      },
    );

  return (
    <li className="grid gap-3 rounded-control border-(length:--border-w) p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <span className="min-w-0 break-words">{report.name}</span>
            {archived && (
              <Badge tone="neutral">
                {t("reportBuilder.saved.archivedBadge")}
              </Badge>
            )}
            {isLoaded && (
              <Badge tone="brand">{t("reportBuilder.saved.openBadge")}</Badge>
            )}
          </p>
          {report.description && (
            <p className="text-sm leading-5 text-muted-foreground">
              {report.description}
            </p>
          )}
          <p className="text-sm leading-5 text-muted-foreground">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onOpen}>
            <FolderOpen aria-hidden="true" />
            {t("reportBuilder.saved.open")}
          </Button>
          {!archived && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSchedule}
            >
              <CalendarClock aria-hidden="true" />
              {t("reportBuilder.saved.schedule")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={update.isPending}
            onClick={setStatus}
          >
            {archived ? (
              <RotateCcw aria-hidden="true" />
            ) : (
              <Archive aria-hidden="true" />
            )}
            {archived
              ? t("reportBuilder.saved.restore")
              : t("reportBuilder.saved.archive")}
          </Button>
        </div>
      </div>
      {schedules.length > 0 && (
        <ul
          aria-label={t("reportBuilder.saved.schedulesLabel", {
            name: report.name,
          })}
          className="grid gap-2"
        >
          {schedules.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SavedReportsPanel({
  loadedId,
  onOpen,
}: {
  loadedId: string | null;
  onOpen: (report: SavedReport) => void;
}) {
  const t = useT();
  const saved = useSavedReports();
  const schedules = useReportSchedules();
  const [scheduling, setScheduling] = useState<SavedReport | null>(null);

  let body;
  if (saved.isError) {
    body = isOfflineError(saved.error) ? (
      <ErrorState
        icon={WifiOff}
        title={t("reportBuilder.offline.title")}
        description={t("reportBuilder.offline.hint")}
        onRetry={() => void saved.refetch()}
      />
    ) : (
      <ErrorState
        title={t("reportBuilder.saved.errorTitle")}
        description={reportErrorText(t, saved.error)}
        onRetry={() => void saved.refetch()}
      />
    );
  } else if (saved.data === undefined) {
    body = (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  } else if (saved.data.length === 0) {
    body = (
      <EmptyState
        className="py-6"
        title={t("reportBuilder.saved.emptyTitle")}
        description={t("reportBuilder.saved.emptyHint")}
      />
    );
  } else {
    body = (
      <div className="grid gap-3">
        {schedules.isError && (
          <p role="alert" className="text-sm leading-5 text-danger">
            {t("reportBuilder.schedule.loadFailed")}
          </p>
        )}
        <ul className="grid gap-3">
          {saved.data.map((report) => (
            <SavedRow
              key={report.id}
              report={report}
              schedules={(schedules.data ?? []).filter(
                (schedule) => schedule.savedReportId === report.id,
              )}
              isLoaded={report.id === loadedId}
              onOpen={() => onOpen(report)}
              onSchedule={() => setScheduling(report)}
            />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <StepCard
      title={t("reportBuilder.saved.title")}
      hint={t("reportBuilder.saved.hint")}
    >
      {body}
      <ScheduleDialog
        report={scheduling}
        open={scheduling !== null}
        onOpenChange={(open) => {
          if (!open) setScheduling(null);
        }}
      />
    </StepCard>
  );
}
