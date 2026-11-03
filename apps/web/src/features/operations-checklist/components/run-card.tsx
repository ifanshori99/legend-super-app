// One run on the checklist board as a tappable card: template, status,
// deadline, assignee, scope and progress. The card is a router link, so the
// whole tile is the 60px-min touch target; no nested interactive elements.
import { AlertTriangle, CalendarClock, UserRound } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import {
  escalationOf,
  formatDateTime,
  formatDuration,
  needsAction,
  remainingMs,
  runProgress,
  statusLabelKey,
  typeLabelKey,
  type RunRow,
} from "../logic.ts";
import { shiftName, stationName, userName } from "../fixtures.ts";
import { EscalationBadge, RunStatusPill } from "./checklist-status.tsx";

export function RunCard({
  row,
  nowMs,
  clientNowMs,
  timeZone,
  zoneName,
}: {
  row: RunRow;
  /** Stable clock for urgency/escalation (server and first client render). */
  nowMs: number;
  /** Client clock for the ticking remaining-time text; null before hydration. */
  clientNowMs: number | null;
  timeZone: string;
  zoneName: string | null;
}) {
  const t = useT();
  const { run, template, scope } = row;
  const progress = runProgress(run);
  const escalation = escalationOf(run, nowMs);
  const urgent = needsAction(run, nowMs);
  const templateName = template?.name ?? t("opsChecklist.runs.templateUnknown");
  const shift =
    shiftName(scope.shiftTemplateId) ?? t("opsChecklist.runs.scopeAnyShift");
  const station =
    stationName(scope.stationId) ?? t("opsChecklist.runs.scopeAnyStation");
  const zone = zoneName ?? t("opsChecklist.runs.scopeAnyZone");
  const assignee =
    userName(run.assignedTo) ?? t("opsChecklist.runs.unknownAssignee");
  const due = formatDateTime(run.dueAt, timeZone);
  const remaining = remainingMs(run, clientNowMs ?? nowMs);
  const percent =
    progress.total === 0
      ? 0
      : Math.round((progress.done / progress.total) * 100);

  return (
    <Link
      to="/operasional/checklist/$runId"
      params={{ runId: run.id }}
      aria-label={t("opsChecklist.runs.cardLabel", {
        name: templateName,
        status: t(statusLabelKey(run.status)),
        time: due,
      })}
      data-slot="checklist-run-card"
      data-run-id={run.id}
      data-run-status={run.status}
      data-overdue={urgent || undefined}
      data-escalation={escalation}
      className={cn(
        "flex flex-col gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card text-foreground shadow-hairline transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        // Q25: urgent = 2px border + 6px start rule in the status colour.
        urgent && "border-2 border-danger border-s-[6px]",
      )}
    >
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span className="grid min-w-0 gap-1">
          <span className="type-heading">{templateName}</span>
          {template && (
            <Badge tone="neutral">{t(typeLabelKey(template.type))}</Badge>
          )}
        </span>
        <RunStatusPill status={run.status} />
      </span>

      <span className="flex flex-wrap items-center gap-1.5">
        <EscalationBadge escalation={escalation} />
        {progress.failed > 0 &&
          (escalation === "none" ? (
            // A failed item alone makes the card urgent: it carries the one
            // solid pill the urgent card needs (DESIGN.md Q25).
            <StatusPill status="danger" solid icon={AlertTriangle}>
              {t("opsChecklist.runs.progressFailed", {
                count: progress.failed,
              })}
            </StatusPill>
          ) : (
            <Badge tone="danger">
              {t("opsChecklist.runs.progressFailed", {
                count: progress.failed,
              })}
            </Badge>
          ))}
      </span>

      <span className="grid gap-1 text-sm leading-5 text-muted-foreground">
        <span className="flex items-center gap-1.5 tabular">
          <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
          {t("opsChecklist.runs.dueAt", { time: due })}
        </span>
        <span className="flex items-center gap-1.5">
          <UserRound className="size-4 shrink-0" aria-hidden="true" />
          {t("opsChecklist.runs.assignee", { name: assignee })}
        </span>
        <span className="truncate">
          {t("opsChecklist.runs.scope", { shift, station, zone })}
        </span>
      </span>

      <span className="grid gap-1.5">
        <span className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-semibold tabular">
            {t("opsChecklist.runs.progress", {
              done: progress.done,
              total: progress.total,
            })}
          </span>
          {clientNowMs !== null &&
            (escalation === "none" ? (
              <span className="text-muted-foreground tabular">
                {t("opsChecklist.runs.remaining", {
                  duration: formatDuration(remaining, t),
                })}
              </span>
            ) : (
              <span className="font-semibold text-danger tabular">
                {t("opsChecklist.runs.late", {
                  duration: formatDuration(remaining, t),
                })}
              </span>
            ))}
        </span>
        <span
          aria-hidden="true"
          className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
        >
          <span
            className="block h-full rounded-full bg-foreground"
            style={{ width: `${percent}%` }}
          />
        </span>
        {run.status === "completed" || run.status === "failed" ? (
          run.completedAt !== null && (
            <span className="text-sm text-muted-foreground tabular">
              {t("opsChecklist.runs.completedAt", {
                time: formatDateTime(run.completedAt, timeZone),
              })}
            </span>
          )
        ) : (
          <span className="sr-only">
            {t("opsChecklist.runs.progress", {
              done: progress.done,
              total: progress.total,
            })}
          </span>
        )}
      </span>
    </Link>
  );
}
