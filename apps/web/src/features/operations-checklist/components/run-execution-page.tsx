// /operasional/checklist/$runId — phone-first checklist execution (PRD v1.7
// §3 F41, OPS-01). A pending run must be started through the contract machine
// before answers are accepted; the close button stays disabled until every
// snapshot item carries its required evidence (`runOutcome`), and a failed
// item closes the run as failed.
import * as React from "react";
import {
  ArrowLeft,
  CalendarClock,
  MapPin,
  Play,
  UserRound,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useOutletClock } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { ApiError } from "@/lib/api/errors";
import {
  escalationOf,
  formatDateTime,
  formatDuration,
  resultOf,
  runOutcome,
  runProgress,
  runScope,
  typeLabelKey,
} from "../logic.ts";
import { shiftName, stationName, userName } from "../fixtures.ts";
import {
  useChecklistRun,
  useChecklistRunTransition,
  useChecklistTemplate,
  useFloorZones,
} from "../hooks.ts";
import { useNowMs } from "../use-now.ts";
import { useChecklistAnswerQueue } from "../use-answer-queue.ts";
import { ChecklistItemCard } from "./checklist-item-card.tsx";
import { EscalationBadge, RunStatusPill } from "./checklist-status.tsx";
import { OfflineNotice } from "./offline-notice.tsx";

function RunSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <span className="sr-only" role="status">
        {t("opsChecklist.run.loading")}
      </span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full rounded-container" />
      <Skeleton className="h-56 w-full rounded-container" />
    </div>
  );
}

export function ChecklistRunPage({ runId }: { runId: string }) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const { clock } = useOutletClock();
  const clientNowMs = useNowMs();
  const [serverNowMs] = React.useState(() => new Date().getTime());
  const nowMs = clientNowMs ?? serverNowMs;
  const runQuery = useChecklistRun(runId);
  const run = runQuery.data;
  const answerQueue = useChecklistAnswerQueue(run);
  const templateQuery = useChecklistTemplate(run?.templateId);
  const floorsQuery = useFloorZones();
  const transition = useChecklistRunTransition(runId);

  const zoneById: ReadonlyMap<string, string> = new Map(
    (floorsQuery.data?.data.zones ?? []).map((zone) => [zone.id, zone.name]),
  );

  if (runQuery.isPending) return <RunSkeleton />;

  if (runQuery.error instanceof ApiError && runQuery.error.status === 404)
    return (
      <EmptyState
        title={t("opsChecklist.run.notFoundTitle")}
        description={t("opsChecklist.run.notFoundHint")}
        action={
          <Button asChild variant="outline">
            <Link to="/operasional/checklist">
              {t("opsChecklist.run.back")}
            </Link>
          </Button>
        }
      />
    );

  if (runQuery.error)
    return (
      <ErrorState
        error={runQuery.error ?? templateQuery.error}
        title={t("opsChecklist.run.errorTitle")}
        description={t("opsChecklist.run.errorHint")}
        onRetry={() => {
          void runQuery.refetch();
          void templateQuery.refetch();
        }}
      />
    );

  if (!run) return <RunSkeleton />;

  const template = templateQuery.data;
  const progress = runProgress(run);
  const outcome = runOutcome(run);
  const escalation = escalationOf(run, nowMs);
  const scope = runScope(run, template);
  const shift =
    shiftName(scope.shiftTemplateId) ?? t("opsChecklist.runs.scopeAnyShift");
  const station =
    stationName(scope.stationId) ?? t("opsChecklist.runs.scopeAnyStation");
  const zone =
    (scope.zoneId === null ? null : (zoneById.get(scope.zoneId) ?? null)) ??
    t("opsChecklist.runs.scopeAnyZone");
  const assignee =
    userName(run.assignedTo) ?? t("opsChecklist.runs.unknownAssignee");
  const pendingItems = run.items.filter(
    (item) => (resultOf(run, item.id)?.status ?? "pending") === "pending",
  );
  const finishedItems = run.items.filter(
    (item) => (resultOf(run, item.id)?.status ?? "pending") !== "pending",
  );
  const percent =
    progress.total === 0
      ? 0
      : Math.round((progress.done / progress.total) * 100);

  function startRun() {
    if (!online) return;
    transition.mutate("start", {
      onSuccess: () =>
        toast({ title: t("opsChecklist.run.started"), tone: "success" }),
      onError: () =>
        toast({ title: t("opsChecklist.run.startFailed"), tone: "danger" }),
    });
  }

  function closeRun() {
    if (!outcome.ready || outcome.outcome === null || !online) return;
    const failed = outcome.outcome === "failed";
    transition.mutate(failed ? "fail" : "complete", {
      onSuccess: () =>
        toast({
          title: t(
            failed
              ? "opsChecklist.run.completedFailed"
              : "opsChecklist.run.completed",
          ),
          tone: failed ? "info" : "success",
        }),
      onError: () =>
        toast({
          title: t("opsChecklist.run.transitionFailed"),
          tone: "danger",
        }),
    });
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-4">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/operasional/checklist">
            <ArrowLeft aria-hidden="true" />
            {t("opsChecklist.run.back")}
          </Link>
        </Button>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h1 className="type-display">
            {template?.name ?? t("opsChecklist.runs.templateUnknown")}
          </h1>
          {template && (
            <Badge tone="neutral">{t(typeLabelKey(template.type))}</Badge>
          )}
        </div>
        <RunStatusPill status={run.status} />
      </header>

      {!online && (
        <OfflineNotice
          title={t("opsChecklist.run.offlineTitle")}
          hint={t("opsChecklist.run.queueOfflineHint")}
        />
      )}

      {(answerQueue.entries.length > 0 ||
        answerQueue.conflicts.length > 0 ||
        answerQueue.error) && (
        <Card data-slot="checklist-answer-queue">
          <p role="status" aria-live="polite" className="text-sm leading-5">
            {t("opsChecklist.run.queuePending", {
              count: answerQueue.entries.length,
            })}
          </p>
          {answerQueue.conflicts.length > 0 && (
            <p role="status" aria-live="polite" className="text-sm leading-5">
              {t("opsChecklist.run.queueConflicts", {
                count: answerQueue.conflicts.length,
              })}
            </p>
          )}
          {answerQueue.error && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {answerQueue.error}
            </p>
          )}
          {answerQueue.entries.length > 0 && (
            <Button
              type="button"
              variant="outline"
              disabled={!online || !answerQueue.ready}
              loading={answerQueue.replaying}
              onClick={() => void answerQueue.retry()}
            >
              {t("opsChecklist.run.queueRetry")}
            </Button>
          )}
        </Card>
      )}

      <Card data-slot="checklist-run-progress">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <span className="type-eyebrow text-muted-foreground">
              {t("opsChecklist.run.progressTitle")}
            </span>
            <span className="text-3xl leading-9 font-bold tabular">
              {t("opsChecklist.runs.progress", {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          </div>
          <EscalationBadge escalation={escalation} />
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={t("opsChecklist.run.progressTitle")}
          className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className="h-full rounded-full bg-foreground"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="grid gap-1 text-sm leading-5 text-muted-foreground">
          <div className="flex items-center gap-1.5 tabular">
            <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
            <span>
              {t("opsChecklist.runs.dueAt", {
                time: formatDateTime(run.dueAt, clock.timeZone),
              })}
            </span>
          </div>
          {clientNowMs !== null && (
            <div className="flex items-center gap-1.5 tabular">
              <span
                className={
                  escalation === "none"
                    ? undefined
                    : "font-semibold text-danger"
                }
              >
                {escalation === "none"
                  ? t("opsChecklist.runs.remaining", {
                      duration: formatDuration(
                        Date.parse(run.dueAt) - clientNowMs,
                        t,
                      ),
                    })
                  : t("opsChecklist.runs.late", {
                      duration: formatDuration(
                        Date.parse(run.dueAt) - clientNowMs,
                        t,
                      ),
                    })}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <UserRound className="size-4 shrink-0" aria-hidden="true" />
            <span>{t("opsChecklist.runs.assignee", { name: assignee })}</span>
          </div>
          <div className="flex items-start gap-1.5">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {t("opsChecklist.runs.scope", { shift, station, zone })}
            </span>
          </div>
        </div>
      </Card>

      {run.status === "pending" && (
        <Card data-slot="checklist-run-start">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.run.pendingHint")}
          </p>
          <Button
            type="button"
            loading={transition.isPending && transition.variables === "start"}
            disabled={!online}
            onClick={startRun}
          >
            <Play aria-hidden="true" />
            {t("opsChecklist.run.start")}
          </Button>
        </Card>
      )}

      {run.status !== "pending" && run.status !== "in_progress" && (
        <p
          data-slot="checklist-run-closed"
          className="rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground"
        >
          {t("opsChecklist.run.closedHint")}
        </p>
      )}

      {pendingItems.length > 0 && (
        <section aria-labelledby={`${runId}-pending`} className="grid gap-2">
          <h2
            id={`${runId}-pending`}
            className="flex flex-wrap items-center gap-2 type-title"
          >
            {t("opsChecklist.run.sectionPending")}
            <Badge tone="warning">{pendingItems.length}</Badge>
          </h2>
          <ul className="grid gap-3">
            {pendingItems.map((item) => (
              <li key={item.id} className="min-w-0">
                <ChecklistItemCard
                  runId={run.id}
                  outletId={run.outletId}
                  item={item}
                  result={resultOf(run, item.id)}
                  editable={run.status === "in_progress"}
                  timeZone={clock.timeZone}
                  answerQueue={answerQueue}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {finishedItems.length > 0 && (
        <section aria-labelledby={`${runId}-finished`} className="grid gap-2">
          <h2
            id={`${runId}-finished`}
            className="flex flex-wrap items-center gap-2 type-title"
          >
            {t("opsChecklist.run.sectionFinished")}
            <Badge tone="neutral">{finishedItems.length}</Badge>
          </h2>
          <ul className="grid gap-3">
            {finishedItems.map((item) => (
              <li key={item.id} className="min-w-0">
                <ChecklistItemCard
                  runId={run.id}
                  outletId={run.outletId}
                  item={item}
                  result={resultOf(run, item.id)}
                  editable={false}
                  timeZone={clock.timeZone}
                  answerQueue={answerQueue}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.status === "in_progress" && (
        <Card data-slot="checklist-run-actions">
          {!outcome.ready && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("opsChecklist.run.completeBlocked")}
            </p>
          )}
          <Button
            type="button"
            variant={outcome.outcome === "failed" ? "destructive" : "default"}
            disabled={!outcome.ready || !online}
            loading={
              transition.isPending &&
              (transition.variables === "complete" ||
                transition.variables === "fail")
            }
            onClick={closeRun}
          >
            {outcome.outcome === "failed"
              ? t("opsChecklist.run.completeFailed")
              : t("opsChecklist.run.complete")}
          </Button>
        </Card>
      )}
    </div>
  );
}
