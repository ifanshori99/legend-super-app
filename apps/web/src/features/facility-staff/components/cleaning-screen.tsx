// /fasilitas/kebersihan — the cleaning queue (PRD v1.7 §3 F25 "Siklus
// Kebersihan", FAC-06). Due tasks come from the staff board (one open cleaning
// task per dirty unit); the checklist dialog runs the contract's cleaning cycle
// and the unit returns to available only when the API accepts it.
import * as React from "react";
import { ClipboardCheck, RefreshCw, SprayCan } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { cleaningTaskStatus } from "@starter/shared/facility";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useStaffFacility,
  useStartCleaningTask,
  useUnitBoard,
} from "../hooks.ts";
import {
  CHECKLIST_KEYS,
  areaName,
  clock,
  dueCleaningTasks,
  type StatusKind,
} from "../view.ts";
import { CleaningDialog } from "./cleaning-dialog.tsx";
import {
  OfflineNotice,
  StaffEmpty,
  StaffError,
  StaffLoading,
  StaffPageHeader,
  StaffSubNav,
} from "./staff-chrome.tsx";

const TASK_STATUS: Record<
  "pending" | "in_progress" | "done",
  {
    labelKey:
      | "facilityStaff.cleaning.status.pending"
      | "facilityStaff.cleaning.status.inProgress"
      | "facilityStaff.cleaning.status.done";
    tone: StatusKind;
  }
> = {
  pending: {
    labelKey: "facilityStaff.cleaning.status.pending",
    tone: "warning",
  },
  in_progress: {
    labelKey: "facilityStaff.cleaning.status.inProgress",
    tone: "info",
  },
  done: { labelKey: "facilityStaff.cleaning.status.done", tone: "success" },
};

export function CleaningScreen({
  facilityId,
  taskId,
}: {
  facilityId?: string;
  taskId?: string;
}) {
  const t = useT();
  const toast = useToast();
  const { timeZone } = useOutletClock();
  const { facilities, facility, config } = useStaffFacility(facilityId, {
    releasedOnly: true,
  });
  const board = useUnitBoard(facility?.id ?? null);
  const startTask = useStartCleaningTask();
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(
    taskId ?? null,
  );

  const loading =
    facilities.isPending ||
    (facility !== null && (config.isPending || board.isPending));
  const failed = facilities.isError || config.isError || board.isError;
  const retry = () => {
    void facilities.refetch();
    void config.refetch();
    void board.refetch();
  };

  const rows = board.data?.rows ?? [];
  const areas = config.data?.areas ?? [];
  const due = dueCleaningTasks(rows).sort((a, b) => {
    const rank = (status: "pending" | "in_progress" | "done") =>
      status === "in_progress" ? 0 : status === "pending" ? 1 : 2;
    const byStatus =
      rank(cleaningTaskStatus(a.task)) - rank(cleaningTaskStatus(b.task));
    if (byStatus !== 0) return byStatus;
    return Date.parse(a.task.createdAt) - Date.parse(b.task.createdAt);
  });
  const selected = due.find((item) => item.task.id === selectedTaskId) ?? null;

  const quickStart = (args: { taskId: string; unitCode: string }) => {
    startTask.mutate(
      { taskId: args.taskId, body: {} },
      {
        onSuccess: () =>
          toast({
            title: t("facilityStaff.cleaning.toast.started", {
              unit: args.unitCode,
            }),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: error.message,
            tone: "danger",
          }),
      },
    );
  };

  return (
    <div
      data-slot="facility-staff-screen"
      data-screen="cleaning"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4"
    >
      <StaffPageHeader
        titleKey="facilityStaff.cleaning.title"
        hintKey="facilityStaff.cleaning.hint"
        facilityName={facility?.name}
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => void board.refetch()}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" />
            {t("facilityStaff.common.refresh")}
          </Button>
        }
      />

      <StaffSubNav current="cleaning" facilityId={facility?.id} />
      <OfflineNotice />

      {loading && <StaffLoading labelKey="common.loading" />}

      {!loading && failed && (
        <StaffError
          titleKey="facilityStaff.cleaning.error.title"
          hintKey="facilityStaff.cleaning.error.hint"
          onRetry={retry}
          error={facilities.error ?? config.error ?? board.error}
        />
      )}

      {!loading && !failed && (!facility || due.length === 0) && (
        <StaffEmpty
          titleKey="facilityStaff.cleaning.empty.title"
          hintKey="facilityStaff.cleaning.empty.hint"
          icon={ClipboardCheck}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/fasilitas" search={{ facilityId: facility?.id }}>
                <SprayCan aria-hidden="true" />
                {t("facilityStaff.common.openBoard")}
              </Link>
            </Button>
          }
        />
      )}

      {!loading && !failed && facility && due.length > 0 && (
        <>
          <Card
            data-slot="cleaning-queue-head"
            role="region"
            aria-label={t("facilityStaff.cleaning.dueTitle")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="type-eyebrow">
                {t("facilityStaff.cleaning.dueTitle")}
              </h2>
              <StatusPill status="warning" solid className="text-sm">
                {t("facilityStaff.cleaning.dueCount", { count: due.length })}
              </StatusPill>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("facilityStaff.cleaning.dueHint")}
            </p>
          </Card>

          <ul className="grid list-none gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {due.map(({ row, task }) => {
              const status = cleaningTaskStatus(task);
              const meta = TASK_STATUS[status];
              const doneCount = CHECKLIST_KEYS.filter(
                (key) =>
                  task.checklist.find((item) => item.key === key)?.done ===
                  true,
              ).length;
              return (
                <li key={task.id}>
                  <Card
                    data-slot="cleaning-task"
                    data-task-id={task.id}
                    data-unit-code={row.unit.code}
                    data-task-status={status}
                    className="h-full"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="grid gap-0.5">
                        <h2 className="type-title">
                          {t("facilityStaff.cleaning.taskUnit", {
                            unit: row.unit.code,
                            area: areaName(areas, row.unit.areaId),
                          })}
                        </h2>
                        <p className="text-sm text-muted-foreground tabular">
                          {t("facilityStaff.cleaning.checklistProgress", {
                            done: doneCount,
                            total: CHECKLIST_KEYS.length,
                          })}
                        </p>
                      </div>
                      <StatusPill status={meta.tone} className="text-sm">
                        {t(meta.labelKey)}
                      </StatusPill>
                    </div>

                    <p className="text-sm text-muted-foreground tabular">
                      {task.startedAt
                        ? t("facilityStaff.cleaning.startedAt", {
                            time: clock(task.startedAt, timeZone),
                          })
                        : t("facilityStaff.cleaning.dialog.startHint")}
                    </p>

                    <div className="mt-auto flex flex-wrap gap-2">
                      {status === "pending" && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          loading={
                            startTask.isPending &&
                            startTask.variables?.taskId === task.id
                          }
                          onClick={() =>
                            quickStart({
                              taskId: task.id,
                              unitCode: row.unit.code,
                            })
                          }
                        >
                          <SprayCan aria-hidden="true" />
                          {t("facilityStaff.cleaning.action.start")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant={
                          status === "in_progress" ? "secondary" : "outline"
                        }
                        size="sm"
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <ClipboardCheck aria-hidden="true" />
                        {t("facilityStaff.cleaning.action.open")}
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {selected && (
        <CleaningDialog
          task={selected.task}
          unitCode={selected.row.unit.code}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
