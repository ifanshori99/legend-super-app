// The onboarding/offboarding checklist: tasks grouped by the contract's
// categories, each with its status and the actions the contract allows from
// that status (PRD v1.7 §3 D26 "Checklist per jabatan", F24).
//
// Actions go through `useChecklistTaskAction`: the contract's
// `transitionChecklistTask` decides the next status, the mock runtime's store
// persists it. No task-action endpoint exists yet, so the card says so.
import * as React from "react";
import { CircleAlert, Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type {
  ChecklistAction,
  ChecklistTask,
  ChecklistTemplate,
} from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import { useChecklistTaskAction } from "../hooks.ts";
import {
  ACTION_LABEL,
  CATEGORY_LABEL,
  availableActions,
  formatBusinessDate,
  formatDateTimeDate,
  groupTasksByCategory,
} from "../lib.ts";
import { TaskStatusBadge } from "./task-status.tsx";

const ACTION_ARIA = {
  complete: "lifecycle.actions.completeNamed",
  block: "lifecycle.actions.blockNamed",
  unblock: "lifecycle.actions.unblockNamed",
  waive: "lifecycle.actions.waiveNamed",
} as const;

// A checklist shows many rows: none of them may take the filled accent
// (DESIGN.md §1 decision log, Q21). "Selesaikan" is the neutral `secondary`
// button, the same call the KDS bump made on a multi-ticket board.
const ACTION_VARIANT: Record<
  ChecklistAction,
  "secondary" | "outline" | "ghost"
> = {
  complete: "secondary",
  block: "ghost",
  unblock: "outline",
  waive: "ghost",
};

/** Why an action is not allowed yet (shown under the row), or null. */
export type ActionLock = (
  task: ChecklistTask,
  action: ChecklistAction,
) => string | null;

function TaskRow({
  task,
  pending,
  onAction,
  actionLock,
}: {
  task: ChecklistTask;
  pending: boolean;
  onAction: (task: ChecklistTask, action: ChecklistAction) => void;
  actionLock?: ActionLock;
}) {
  const t = useT();
  const reasonId = React.useId();
  const actions = availableActions(task.status);
  const locks = actions.map((action) => actionLock?.(task, action) ?? null);
  const reason = locks.find((lock) => lock !== null) ?? null;
  return (
    <li className="flex flex-col gap-3 border-b py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="grid min-w-0 gap-1">
        <p className="text-(length:--density-text) font-semibold">
          {task.title}
        </p>
        <p className="text-sm text-muted-foreground">
          {task.status === "done" && task.doneAt !== null
            ? t("lifecycle.checklist.doneAt", {
                date: formatDateTimeDate(task.doneAt),
              })
            : task.dueAt === null
              ? t("lifecycle.checklist.noDue")
              : t("lifecycle.checklist.due", {
                  date: formatBusinessDate(task.dueAt.slice(0, 10)),
                })}
        </p>
        {reason === null ? null : (
          <p id={reasonId} className="text-sm leading-5 text-muted-foreground">
            {reason}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <TaskStatusBadge status={task.status} />
        {actions.map((action, index) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant={ACTION_VARIANT[action]}
            loading={pending}
            disabled={locks[index] !== null}
            aria-describedby={locks[index] === null ? undefined : reasonId}
            onClick={() => onAction(task, action)}
            aria-label={t(ACTION_ARIA[action], { title: task.title })}
          >
            {t(ACTION_LABEL[action])}
          </Button>
        ))}
      </div>
    </li>
  );
}

export function ChecklistCard({
  title,
  tasks,
  template,
  isPending,
  isError,
  onRetry,
  actionLock,
}: {
  title: string;
  tasks: readonly ChecklistTask[];
  template: ChecklistTemplate | null;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  actionLock?: ActionLock;
}) {
  const t = useT();
  const toast = useToast();
  const action = useChecklistTaskAction();
  const groups = groupTasksByCategory(tasks, template);

  function run(task: ChecklistTask, next: ChecklistAction) {
    action.mutate(
      { task, action: next },
      {
        onSuccess: () =>
          toast({ title: t("lifecycle.checklist.saved"), tone: "success" }),
        onError: (error) =>
          toast({
            title: t("lifecycle.checklist.saveFailed"),
            description: error instanceof ApiError ? error.message : undefined,
            tone: "danger",
          }),
      },
    );
  }

  const pendingTaskId = action.isPending ? action.variables?.task.id : null;

  return (
    <CardShell>
      <CardShellBody>
        <header className="grid gap-1 border-b p-card">
          <h2 className="type-title">{title}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("lifecycle.checklist.description")}
          </p>
          <p className="mt-1 flex items-start gap-1.5 text-sm leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("lifecycle.checklist.localPreview")}
          </p>
        </header>
        {isPending ? (
          <div className="grid gap-2 p-card" aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-row" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            icon={CircleAlert}
            title={t("lifecycle.checklist.errorTitle")}
            description={t("lifecycle.checklist.errorHint")}
            onRetry={onRetry}
          />
        ) : groups.length === 0 ? (
          <EmptyState
            title={t("lifecycle.checklist.empty")}
            description={t("lifecycle.checklist.emptyHint")}
          />
        ) : (
          <div className="grid gap-5 p-card">
            {groups.map((group) => (
              <section key={group.category} className="grid gap-1">
                <h3 className="type-eyebrow text-muted-foreground">
                  {t(CATEGORY_LABEL[group.category])}
                </h3>
                <ul className="border-t">
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      pending={pendingTaskId === task.id}
                      onAction={run}
                      actionLock={actionLock}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </CardShellBody>
    </CardShell>
  );
}
