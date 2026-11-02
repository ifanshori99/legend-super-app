// "Riwayat absensi" (PRD §3 Kelompok D 33 "Absen" + F25 "Koreksi Absensi"):
// this employee's own logs grouped by business date, and the corrections they
// sent. Every tab has loading, empty and error states; a correction can be
// filed for a log or for a day where the log is missing entirely.
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, FileClock, History, Pencil } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AttendanceLog } from "@starter/shared/hris";
import {
  useAttendanceHistory,
  useCorrectionHistory,
  useMyHrisProfile,
} from "../hooks.ts";
import {
  correctionStatusKey,
  correctionStatusTone,
  formatBusinessDate,
  formatDate,
  formatTime,
  groupLogsByDate,
  methodLabelKey,
  typeLabelKey,
  typeShortLabelKey,
  validityLabelKey,
  validityStatus,
} from "../state.ts";
import { ATTENDANCE_TYPE_ICONS } from "./attendance-type-icon.ts";
import { CorrectionDialog } from "./correction-dialog.tsx";
import {
  SectionEmpty,
  SectionError,
  SectionSkeleton,
} from "./section-states.tsx";

export type HistoryTab = "logs" | "corrections";

export function AttendanceHistory({ initialTab }: { initialTab: HistoryTab }) {
  const t = useT();
  const profile = useMyHrisProfile();
  const [tab, setTab] = useState<HistoryTab>(initialTab);
  const [dialogLog, setDialogLog] = useState<AttendanceLog | null | undefined>(
    undefined,
  );
  const logs = useAttendanceHistory(profile.isSuccess);
  const corrections = useCorrectionHistory(
    profile.isSuccess && tab === "corrections",
  );

  const timeZone = profile.data?.outlet.timeZone;
  const groups = useMemo(
    () => (timeZone ? groupLogsByDate(logs.logs, timeZone) : []),
    [logs.logs, timeZone],
  );

  if (profile.isPending)
    return (
      <div aria-busy="true" className="grid gap-4">
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );

  if (profile.isError || !profile.data)
    return (
      <ErrorState
        title={t("hris.state.profileError")}
        description={t("hris.state.retryHint")}
        onRetry={() => void profile.refetch()}
      />
    );

  const zone = profile.data.outlet.timeZone;
  const outletId = profile.data.outlet.id;

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan">
            <ChevronLeft aria-hidden="true" />
            {t("hris.attendance.back")}
          </Link>
        </Button>
        <header className="grid gap-1">
          <h1 className="text-2xl leading-8 font-semibold tracking-tight">
            {t("hris.history.title")}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hris.history.subtitle")}
          </p>
        </header>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => setDialogLog(null)}
      >
        <Pencil aria-hidden="true" />
        {t("hris.history.unmatched")}
      </Button>

      <Tabs value={tab} onValueChange={(value) => setTab(value as HistoryTab)}>
        <TabsList>
          <TabsTrigger value="logs">{t("hris.history.tabs.logs")}</TabsTrigger>
          <TabsTrigger value="corrections">
            {t("hris.history.tabs.corrections")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="logs">
          {logs.isPending ? (
            <SectionSkeleton rows={6} />
          ) : logs.isError ? (
            <SectionError
              title={t("hris.state.logsError")}
              description={t("hris.state.retryHint")}
              onRetry={() => void logs.refetch()}
            />
          ) : groups.length === 0 ? (
            <SectionEmpty
              icon={History}
              title={t("hris.history.logsEmpty")}
              description={t("hris.history.logsEmptyHint")}
            />
          ) : (
            <div className="grid gap-4">
              {groups.map((group) => (
                <section key={group.businessDate} className="grid gap-2">
                  <h2 className="text-sm leading-5 font-semibold text-muted-foreground">
                    {formatBusinessDate(group.businessDate, zone)}
                  </h2>
                  <Card>
                    <ul className="divide-y">
                      {group.logs.map((log) => {
                        const Icon = ATTENDANCE_TYPE_ICONS[log.type];
                        return (
                          <li
                            key={log.id}
                            className="flex items-center gap-2 py-2.5"
                          >
                            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                              <Icon className="size-4" aria-hidden="true" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm leading-5 font-medium">
                                {t(typeShortLabelKey(log.type))}
                              </p>
                              <p className="truncate text-xs leading-4 text-muted-foreground">
                                {t(methodLabelKey(log.method))}
                                {log.geoDistanceM !== null &&
                                  ` · ${log.geoDistanceM} m`}
                              </p>
                            </div>
                            <div className="grid shrink-0 justify-items-end gap-1">
                              <span className="tabular text-sm leading-5 font-semibold">
                                {formatTime(log.occurredAt, zone)}
                              </span>
                              {log.validity !== "valid" && (
                                <StatusPill
                                  status={validityStatus(log.validity)}
                                >
                                  {t(validityLabelKey(log.validity))}
                                </StatusPill>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("hris.history.correct")}
                              onClick={() => setDialogLog(log)}
                            >
                              <Pencil aria-hidden="true" />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                </section>
              ))}

              {logs.hasNextPage && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  loading={logs.isFetchingNextPage}
                  onClick={() => void logs.fetchNextPage()}
                >
                  {logs.isFetchingNextPage
                    ? t("hris.history.loadingMore")
                    : t("hris.history.loadMore")}
                </Button>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="corrections">
          {corrections.isPending ? (
            <SectionSkeleton rows={4} />
          ) : corrections.isError ? (
            <SectionError
              title={t("hris.state.correctionsError")}
              description={t("hris.state.retryHint")}
              onRetry={() => void corrections.refetch()}
            />
          ) : corrections.corrections.length === 0 ? (
            <SectionEmpty
              icon={FileClock}
              title={t("hris.history.correctionsEmpty")}
              description={t("hris.history.correctionsEmptyHint")}
            />
          ) : (
            <div className="grid gap-4">
              <Card>
                <ul className="divide-y">
                  {corrections.corrections.map((correction) => (
                    <li key={correction.id} className="grid gap-1 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm leading-5 font-medium">
                          {t("hris.history.requestedType", {
                            type: t(typeLabelKey(correction.requestedType)),
                            time: formatTime(
                              correction.requestedOccurredAt,
                              zone,
                            ),
                          })}
                        </p>
                        <StatusPill
                          status={correctionStatusTone(correction.status)}
                        >
                          {t(correctionStatusKey(correction.status))}
                        </StatusPill>
                      </div>
                      <p className="text-sm leading-5">{correction.reason}</p>
                      <p className="text-xs leading-4 text-muted-foreground">
                        {correction.attendanceLogId === null &&
                          `${t("hris.correction.noLog")} · `}
                        {t("hris.history.requestedAt", {
                          date: formatDate(correction.requestedAt, zone),
                        })}
                        {correction.decidedAt &&
                          ` · ${t("hris.history.decidedAt", {
                            date: formatDate(correction.decidedAt, zone),
                          })}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>

              {corrections.hasNextPage && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  loading={corrections.isFetchingNextPage}
                  onClick={() => void corrections.fetchNextPage()}
                >
                  {corrections.isFetchingNextPage
                    ? t("hris.history.loadingMore")
                    : t("hris.history.loadMore")}
                </Button>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CorrectionDialog
        open={dialogLog !== undefined}
        onOpenChange={(open) => {
          if (!open) setDialogLog(undefined);
        }}
        log={dialogLog ?? null}
        outletId={outletId}
        timeZone={zone}
      />
    </div>
  );
}
