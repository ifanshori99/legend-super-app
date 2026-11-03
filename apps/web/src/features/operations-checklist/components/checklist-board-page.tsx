// /operasional/checklist — the checklist board: "Perlu tindakan" strip first
// (DESIGN.md §5 "Operations — status hierarchy", Q25), then shift/station/zone
// filters as segmented groups with counts, then one card per run.
// PRD v1.7 §3 F41 "Checklist Operasional"; OPS-01 (overdue escalation) is
// shown with the contract's own deadline helpers.
import * as React from "react";
import { ClipboardCheck } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { businessDateOf } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import {
  ALL,
  EMPTY_FILTER,
  countBy,
  distinctValues,
  filterRows,
  isOverdueNow,
  needsAction,
  runScope,
  sortRuns,
  type RunFilter,
  type RunRow,
} from "../logic.ts";
import { shiftName, stationName } from "../fixtures.ts";
import {
  useChecklistRuns,
  useChecklistTemplates,
  useFloorZones,
} from "../hooks.ts";
import { useNowMs } from "../use-now.ts";
import { OfflineNotice } from "./offline-notice.tsx";
import { RunCard } from "./run-card.tsx";
import { StartRunDialog } from "./start-run-dialog.tsx";

function BoardSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <span className="sr-only" role="status">
        {t("opsChecklist.runs.loading")}
      </span>
      <Skeleton className="h-24 w-full rounded-container" />
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-56 w-full rounded-container" />
        ))}
      </div>
    </div>
  );
}

/** "Perlu tindakan" strip: the solid pill carries the urgent count (Q25), the
 *  tinted pills break it down, and a clear line says nothing needs action. */
function AttentionStrip({
  rows,
  nowMs,
}: {
  rows: readonly RunRow[];
  nowMs: number;
}) {
  const t = useT();
  const urgent = rows.filter(({ run }) => needsAction(run, nowMs)).length;
  const overdue = rows.filter(({ run }) => isOverdueNow(run, nowMs)).length;
  const failed = rows.filter(({ run }) =>
    run.results.some((result) => result.status === "failed"),
  ).length;
  const missed = rows.filter(({ run }) => run.status === "missed").length;
  return (
    <div
      data-slot="checklist-attention"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-container bg-surface-2 p-3"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="type-eyebrow text-muted-foreground">
          {t("opsChecklist.runs.attention.title")}
        </span>
        {urgent > 0 ? (
          <StatusPill status="danger" solid>
            {t("opsChecklist.runs.attention.urgent", { count: urgent })}
          </StatusPill>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("opsChecklist.runs.attention.clear")}
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {overdue > 0 && (
          <Badge tone="warning">
            {t("opsChecklist.runs.attention.overdue", { count: overdue })}
          </Badge>
        )}
        {failed > 0 && (
          <Badge tone="danger">
            {t("opsChecklist.runs.attention.failed", { count: failed })}
          </Badge>
        )}
        {missed > 0 && (
          <Badge tone="neutral">
            {t("opsChecklist.runs.attention.missed", { count: missed })}
          </Badge>
        )}
      </span>
    </div>
  );
}

export function ChecklistBoardPage() {
  const t = useT();
  const navigate = useNavigate();
  const online = useOnline();
  const { clock } = useOutletClock();
  // The operations shell already knows its outlet (tenant context); the board
  // does not need a second outlet lookup and keeps working when only the
  // checklist endpoints are the subject of a mock scenario.
  const { outlet } = useTenantContext();
  const runsQuery = useChecklistRuns(outlet?.id);
  const templatesQuery = useChecklistTemplates(outlet?.id);
  // Zones are the one scope name the contract serves (the floor endpoint);
  // a failed floor read only hides the zone filter, never blocks the board.
  const floorsQuery = useFloorZones();
  const clientNowMs = useNowMs();
  // Stable fallback clock for the first (server) render and before hydration;
  // time-dependent text still waits for the client clock.
  const [serverNowMs] = React.useState(() => new Date().getTime());
  const nowMs = clientNowMs ?? serverNowMs;
  const [filter, setFilter] = React.useState<RunFilter>(EMPTY_FILTER);
  const [startOpen, setStartOpen] = React.useState(false);

  const zones = floorsQuery.data?.data.zones ?? [];
  const zoneById: ReadonlyMap<string, string> = new Map(
    zones.map((zone) => [zone.id, zone.name]),
  );
  const zoneName = (zoneId: string | null) =>
    zoneId === null ? null : (zoneById.get(zoneId) ?? null);

  if (outlet && (runsQuery.isPending || templatesQuery.isPending))
    return <BoardSkeleton />;

  if (runsQuery.error || templatesQuery.error)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <header className="grid gap-1">
          <h1 className="type-display">{t("opsChecklist.runs.title")}</h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.runs.subtitle")}
          </p>
        </header>
        <ErrorState
          title={t("opsChecklist.runs.errorTitle")}
          description={t("opsChecklist.runs.errorHint")}
          onRetry={() => {
            void runsQuery.refetch();
            void templatesQuery.refetch();
          }}
        />
      </div>
    );

  if (!outlet)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <header className="grid gap-1">
          <h1 className="type-display">{t("opsChecklist.runs.title")}</h1>
        </header>
        <EmptyState
          title={t("state.emptyTitle")}
          description={t("state.emptyHint")}
        />
      </div>
    );

  const templates = templatesQuery.data?.data ?? [];
  const templateById = new Map(templates.map((row) => [row.id, row]));
  const rows: RunRow[] = (runsQuery.data?.data ?? []).map((run) => {
    const template = templateById.get(run.templateId);
    return { run, template, scope: runScope(run, template) };
  });
  const sorted = sortRuns(rows, nowMs);
  const visible = filterRows(sorted, filter);

  const shiftIds = distinctValues(rows, (scope) => scope.shiftTemplateId);
  const stationIds = distinctValues(rows, (scope) => scope.stationId);
  const zoneIds = distinctValues(rows, (scope) => scope.zoneId);
  const shiftCounts = countBy(rows, (scope) => scope.shiftTemplateId);
  const stationCounts = countBy(rows, (scope) => scope.stationId);
  const zoneCounts = countBy(rows, (scope) => scope.zoneId);
  const defaultShiftDate = businessDateOf(new Date(nowMs), clock);

  const optionLabel = (label: string, count: number) =>
    t("opsChecklist.runs.filter.option", { label, count });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="type-display">{t("opsChecklist.runs.title")}</h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.runs.subtitle")}
          </p>
        </div>
        <Button type="button" onClick={() => setStartOpen(true)}>
          {t("opsChecklist.runs.newRun")}
        </Button>
      </header>

      {!online && (
        <OfflineNotice
          title={t("opsChecklist.runs.offlineTitle")}
          hint={t("opsChecklist.runs.offlineHint")}
        />
      )}

      <AttentionStrip rows={rows} nowMs={nowMs} />

      {rows.length > 0 && (
        <div data-slot="checklist-filters" className="grid gap-3">
          {shiftIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="type-eyebrow min-w-16 text-muted-foreground">
                {t("opsChecklist.runs.filter.shift")}
              </span>
              <SegmentedControl
                label={t("opsChecklist.runs.filter.shift")}
                value={filter.shiftTemplateId}
                onValueChange={(value) =>
                  setFilter((current) => ({
                    ...current,
                    shiftTemplateId: value,
                  }))
                }
                options={[
                  {
                    value: ALL,
                    label: optionLabel(
                      t("opsChecklist.runs.filter.allShifts"),
                      rows.length,
                    ),
                  },
                  ...shiftIds.map((id) => ({
                    value: id,
                    label: optionLabel(
                      shiftName(id) ?? id,
                      shiftCounts.get(id) ?? 0,
                    ),
                  })),
                ]}
              />
            </div>
          )}
          {stationIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="type-eyebrow min-w-16 text-muted-foreground">
                {t("opsChecklist.runs.filter.station")}
              </span>
              <SegmentedControl
                label={t("opsChecklist.runs.filter.station")}
                value={filter.stationId}
                onValueChange={(value) =>
                  setFilter((current) => ({ ...current, stationId: value }))
                }
                options={[
                  {
                    value: ALL,
                    label: optionLabel(
                      t("opsChecklist.runs.filter.allStations"),
                      rows.length,
                    ),
                  },
                  ...stationIds.map((id) => ({
                    value: id,
                    label: optionLabel(
                      stationName(id) ?? id,
                      stationCounts.get(id) ?? 0,
                    ),
                  })),
                ]}
              />
            </div>
          )}
          {zoneIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="type-eyebrow min-w-16 text-muted-foreground">
                {t("opsChecklist.runs.filter.zone")}
              </span>
              <SegmentedControl
                label={t("opsChecklist.runs.filter.zone")}
                value={filter.zoneId}
                onValueChange={(value) =>
                  setFilter((current) => ({ ...current, zoneId: value }))
                }
                options={[
                  {
                    value: ALL,
                    label: optionLabel(
                      t("opsChecklist.runs.filter.allZones"),
                      rows.length,
                    ),
                  },
                  ...zoneIds.map((id) => ({
                    value: id,
                    label: optionLabel(
                      zoneById.get(id) ?? id,
                      zoneCounts.get(id) ?? 0,
                    ),
                  })),
                ]}
              />
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t("opsChecklist.runs.emptyTitle")}
          description={t("opsChecklist.runs.emptyHint")}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => setStartOpen(true)}
            >
              {t("opsChecklist.runs.newRun")}
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={t("opsChecklist.runs.emptyFilteredTitle")}
          description={t("opsChecklist.runs.emptyFilteredHint")}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => setFilter(EMPTY_FILTER)}
            >
              {t("opsChecklist.runs.emptyFilteredAction")}
            </Button>
          }
        />
      ) : (
        <ul
          data-slot="checklist-run-list"
          className="grid gap-3 md:grid-cols-2"
        >
          {visible.map((row) => (
            <li key={row.run.id} className="min-w-0">
              <RunCard
                row={row}
                nowMs={nowMs}
                clientNowMs={clientNowMs}
                timeZone={clock.timeZone}
                zoneName={zoneName(row.scope.zoneId)}
              />
            </li>
          ))}
        </ul>
      )}

      <StartRunDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        outletId={outlet.id}
        templates={templates}
        defaultShiftDate={defaultShiftDate}
        zoneName={zoneName}
        onStarted={(run) =>
          void navigate({
            to: "/operasional/checklist/$runId",
            params: { runId: run.id },
          })
        }
      />
    </div>
  );
}
