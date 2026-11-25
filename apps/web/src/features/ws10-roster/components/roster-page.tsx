// /kelola/roster — weekly roster calendar (PRD v1.7 §3 Kelompok D 28 "Roster
// Mingguan", F26, HR-05, AI-13). Week navigation, filters, the drag-and-drop
// grid, contract compliance warnings, copy-previous-week, the AI-13 suggestion
// panel and the publish dialog. Shift writes are LOCAL drafts until the
// assignment endpoint lands (see `draft-store.ts`); publish goes through the
// contract's `publishRoster`.
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import type { OutletId } from "@starter/shared/core";
import {
  addBusinessDays,
  type Employee,
  type ShiftAssignment,
} from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useRetainedAttempt } from "@/lib/use-retained-attempt";
import { publishAttemptPayload } from "../publish-key";
import { useTenantContext } from "@/lib/tenant-context";
import { rosterTemplatesFor, stationName } from "../fixtures";
import {
  useLocalRosterWeek,
  usePublishRoster,
  useRosterEmployees,
  useRosterHolidays,
  useRosterPositions,
  useRosterWeek,
} from "../hooks";
import {
  copyWeekDrafts,
  currentWeekStart,
  draftFromTemplate,
  evaluateWeekCompliance,
  formatDayLabel,
  formatPublishedAt,
  formatWeekRange,
  mergeWeekRows,
  staffingSuggestions,
  todayBusinessDate,
  totalWorkedMinutes,
  weekDays,
  weekStatusOf,
  type RosterSuggestion,
} from "../lib";
import { PublishDialog } from "./publish-dialog";
import { SuggestionPanel } from "./suggestion-panel";
import { TemplatePalette } from "./template-palette";
import { WeekGrid } from "./week-grid";

const ALL = "all";

function rowKey(row: ShiftAssignment): string {
  return `${row.employeeId}|${row.businessDate}|${row.shiftTemplateId ?? ""}`;
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh roster, so
 * filters and the publish dialog of the previous outlet cannot carry over.
 */
export function RosterPage({ weekStart }: { weekStart: string }) {
  const t = useT();
  const { outlet } = useTenantContext();
  if (!outlet)
    return (
      <EmptyState
        title={t("area.noOutletTitle")}
        description={t("area.noOutletHint")}
      />
    );
  return (
    <RosterContent key={outlet.id} outletId={outlet.id} weekStart={weekStart} />
  );
}

function RosterContent({
  outletId,
  weekStart,
}: {
  outletId: OutletId;
  weekStart: string;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();

  const employeesQ = useRosterEmployees(outletId);
  const positionsQ = useRosterPositions();
  const weekQ = useRosterWeek(outletId, weekStart);
  const previousWeekQ = useRosterWeek(outletId, addBusinessDays(weekStart, -7));
  const holidaysQ = useRosterHolidays(weekStart);
  const local = useLocalRosterWeek(outletId, weekStart);
  // Last week as this device sees it: a week published or drafted locally
  // must count for copy-previous-week and for Sunday→Monday rest.
  const previousLocal = useLocalRosterWeek(
    outletId,
    addBusinessDays(weekStart, -7),
  );
  const templates = React.useMemo(
    () => rosterTemplatesFor(outletId),
    [outletId],
  );
  const publish = usePublishRoster();

  const [positionFilter, setPositionFilter] = React.useState<string>(ALL);
  const [stationFilter, setStationFilter] = React.useState<string>(ALL);
  const [publishOpen, setPublishOpen] = React.useState(false);
  // One key per dialog attempt: a double click/retry replays the same request;
  // closing the dialog starts a new attempt (the week's drafts may change).
  // Kept for the same outlet and week across close and reopen: a lost
  // response then replays instead of publishing twice.
  const publishAttempt = useRetainedAttempt("roster.publish");
  const confirmedPublication = React.useRef<string | null>(null);

  const days = weekDays(weekStart);
  const range = formatWeekRange(weekStart);
  const today = todayBusinessDate();

  // Stable array identities: the `?? []` fallback would otherwise be a new
  // array on every render and invalidate every downstream useMemo.
  const employees = React.useMemo(
    () => employeesQ.data?.data ?? [],
    [employeesQ.data],
  );
  const positions = React.useMemo(
    () => positionsQ.data?.data ?? [],
    [positionsQ.data],
  );
  const holidays = React.useMemo(
    () => holidaysQ.data?.data ?? [],
    [holidaysQ.data],
  );
  const previousRows = React.useMemo(
    () =>
      mergeWeekRows({
        base: previousWeekQ.data?.data ?? [],
        publication: previousLocal.publication,
        drafts: previousLocal.drafts,
      }),
    [previousWeekQ.data, previousLocal.publication, previousLocal.drafts],
  );

  const rows = React.useMemo(
    () =>
      mergeWeekRows({
        base: weekQ.data?.data ?? [],
        publication: local.publication,
        drafts: local.drafts,
      }),
    [weekQ.data, local.publication, local.drafts],
  );
  const compliance = React.useMemo(
    () => evaluateWeekCompliance(rows, previousRows),
    [rows, previousRows],
  );

  const positionsById = React.useMemo(
    () => new Map(positions.map((position) => [position.id, position.name])),
    [positions],
  );
  const employeesById = React.useMemo<Map<string, Employee>>(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );
  // Only active templates can become a shift: a drop carries arbitrary
  // dataTransfer text, so an inactive or unknown id is ignored here.
  const templatesById = React.useMemo<Map<string, (typeof templates)[number]>>(
    () =>
      new Map(
        templates
          .filter((template) => template.isActive)
          .map((template) => [template.id, template]),
      ),
    [templates],
  );

  const stationOptions = React.useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows) if (row.stationId !== null) ids.add(row.stationId);
    for (const template of templates)
      if (template.stationId !== null) ids.add(template.stationId);
    return [...ids].sort();
  }, [rows, templates]);

  const visibleEmployees = React.useMemo(
    () =>
      employees
        .filter((employee) => {
          if (positionFilter !== ALL && employee.positionId !== positionFilter)
            return false;
          if (
            stationFilter !== ALL &&
            !rows.some(
              (row) =>
                row.employeeId === employee.id &&
                row.stationId === stationFilter,
            )
          )
            return false;
          return true;
        })
        .slice()
        .sort((left, right) =>
          left.fullName.localeCompare(right.fullName, "id-ID"),
        ),
    [employees, rows, positionFilter, stationFilter],
  );

  const status = weekStatusOf(rows);
  const draftCount = rows.filter((row) => row.status === "draft").length;
  const employeeCount = new Set(rows.map((row) => row.employeeId)).size;
  const canPublish = rows.length > 0 && draftCount > 0;
  const suggestions = React.useMemo(
    () =>
      staffingSuggestions({
        weekStart,
        assignments: rows,
        employees,
        templates,
        previousAssignments: previousRows,
      }),
    [weekStart, rows, employees, templates, previousRows],
  );

  const loading =
    employeesQ.isPending ||
    positionsQ.isPending ||
    weekQ.isPending ||
    holidaysQ.isPending;
  const failed =
    employeesQ.isError ||
    positionsQ.isError ||
    weekQ.isError ||
    holidaysQ.isError;
  const error =
    employeesQ.error ?? positionsQ.error ?? weekQ.error ?? holidaysQ.error;
  const offline = error instanceof ApiError && error.code === "NETWORK_ERROR";

  const goToWeek = (offsetWeeks: number) => {
    void navigate({
      to: "/kelola/roster",
      search: { week: addBusinessDays(weekStart, offsetWeeks * 7) },
    });
  };

  const assign = (
    employeeId: string,
    businessDate: string,
    templateId: string,
  ) => {
    const template = templatesById.get(templateId);
    if (!template) return;
    local.addDrafts([draftFromTemplate(template, employeeId, businessDate)]);
  };

  const acceptSuggestion = (suggestion: RosterSuggestion) => {
    const template =
      suggestion.templateId === null
        ? undefined
        : templatesById.get(suggestion.templateId);
    const employee = employeesById.get(suggestion.employeeId);
    if (!template) return;
    local.addDrafts([
      draftFromTemplate(
        template,
        suggestion.employeeId,
        suggestion.businessDate,
      ),
    ]);
    toast({
      title: t("roster.suggestions.accepted", {
        employee: employee?.fullName ?? suggestion.employeeId,
        date: formatDayLabel(suggestion.businessDate),
      }),
    });
  };

  // Idempotent: a row already in this week (same employee, day, template) is
  // never copied twice, so a second click adds nothing.
  const copyPrevious = () => {
    const copies = copyWeekDrafts(previousRows);
    if (copies.length === 0) {
      toast({ title: t("roster.actions.copyEmpty") });
      return;
    }
    const existing = new Set(rows.map((row) => rowKey(row)));
    const fresh = copies.filter((row) => !existing.has(rowKey(row)));
    if (fresh.length === 0) {
      toast({ title: t("roster.actions.copyAlreadyDone") });
      return;
    }
    local.addDrafts(fresh);
    toast({
      title: t("roster.actions.copied", { count: fresh.length }),
    });
  };

  const openPublish = () => {
    publish.reset();
    setPublishOpen(true);
  };

  const handlePublishOpenChange = (open: boolean) => {
    setPublishOpen(open);
    if (!open) publish.reset();
  };

  const confirmPublish = () => {
    const idempotencyKey = publishAttempt.keyFor(
      publishAttemptPayload({ outletId, weekStart, rows }),
    );
    publish.mutate(
      {
        outletId,
        weekStart,
        idempotencyKey,
      },
      {
        onSuccess: (response) => {
          const publication = response.data;
          // A replayed request returns the same publication; confirm it once
          // (two identical taps must not read as two publications).
          const identity = `${publication.weekStart}|${publication.publishedAt}`;
          if (confirmedPublication.current === identity) return;
          confirmedPublication.current = identity;
          local.recordPublication(publication);
          publishAttempt.settle();
          setPublishOpen(false);
          toast({
            title: t("roster.publish.success", {
              range: formatWeekRange(publication.weekStart),
            }),
          });
        },
      },
    );
  };

  const statusLabel =
    status === "published"
      ? t("roster.week.published")
      : status === "draft"
        ? t("roster.week.draft")
        : t("roster.week.empty");

  return (
    <div className="grid min-w-0 gap-5">
      <CardShell>
        <CardShellBody>
          <div className="flex flex-col gap-3 p-card lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t("roster.week.previous")}
                onClick={() => goToWeek(-1)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t("roster.week.next")}
                onClick={() => goToWeek(1)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
              <div className="grid min-w-0 gap-1">
                <h2 className="type-title">
                  {t("roster.week.heading", { range })}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span
                    data-testid="roster-week-status"
                    aria-label={t("roster.week.statusLabel")}
                  >
                    <StatusPill
                      status={
                        status === "published"
                          ? "success"
                          : status === "draft"
                            ? "warning"
                            : "info"
                      }
                    >
                      {statusLabel}
                    </StatusPill>
                  </span>
                  {local.publication && (
                    <span>
                      {t("roster.week.publishedAt", {
                        date: formatPublishedAt(local.publication.publishedAt),
                      })}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/kelola/roster",
                    search: { week: currentWeekStart() },
                  })
                }
              >
                {t("roster.week.thisWeek")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={previousRows.length === 0}
                onClick={copyPrevious}
              >
                {t("roster.actions.copyPrevious")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canPublish}
                onClick={openPublish}
              >
                {t("roster.actions.publish")}
              </Button>
            </div>
          </div>
        </CardShellBody>
      </CardShell>

      {loading ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : failed ? (
        <CardShell>
          <CardShellBody>
            <ErrorState
              error={
                weekQ.error ??
                employeesQ.error ??
                positionsQ.error ??
                holidaysQ.error
              }
              title={t("roster.errors.load")}
              description={
                offline
                  ? t("roster.errors.offline")
                  : t("roster.errors.loadHint")
              }
              onRetry={() => {
                void employeesQ.refetch();
                void positionsQ.refetch();
                void weekQ.refetch();
                void holidaysQ.refetch();
              }}
            />
          </CardShellBody>
        </CardShell>
      ) : employees.length === 0 ? (
        <CardShell>
          <CardShellBody>
            <EmptyState
              title={t("roster.grid.noEmployees")}
              description={t("roster.grid.noEmployeesHint")}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <>
          <StatStrip label={t("roster.stats.label")}>
            <StatTile
              label={t("roster.stats.shifts")}
              value={<NumberDisplay value={rows.length} size="stat" />}
              context={t("roster.stats.draftContext", { count: draftCount })}
            />
            <StatTile
              label={t("roster.stats.employees")}
              value={<NumberDisplay value={employeeCount} size="stat" />}
              context={t("roster.stats.period", { range })}
            />
            <StatTile
              label={t("roster.stats.hours")}
              value={
                <NumberDisplay
                  value={Math.round(totalWorkedMinutes(rows) / 60)}
                  size="stat"
                />
              }
              context={t("roster.stats.period", { range })}
            />
            <StatTile
              label={t("roster.stats.warnings")}
              value={<NumberDisplay value={compliance.total} size="stat" />}
              context={
                compliance.total === 0
                  ? t("roster.compliance.ok")
                  : t("roster.stats.period", { range })
              }
            />
          </StatStrip>

          <TemplatePalette templates={templates} />

          <p className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-shell p-3 text-sm leading-5 text-muted-foreground shadow-hairline">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("roster.gap.assignment")}
          </p>

          {visibleEmployees.length === 0 ? (
            <CardShell>
              <CardShellBody>
                <EmptyState
                  title={t("roster.grid.noResults")}
                  description={t("roster.grid.noResultsHint")}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPositionFilter(ALL);
                        setStationFilter(ALL);
                      }}
                    >
                      {t("roster.filters.allPositions")}
                    </Button>
                  }
                />
              </CardShellBody>
            </CardShell>
          ) : (
            <WeekGrid
              days={days}
              employees={visibleEmployees}
              rows={rows}
              positions={positionsById}
              holidays={holidays}
              templates={templates}
              compliance={compliance}
              today={today}
              onAssign={assign}
              onRemoveDraft={local.removeDraft}
              toolbar={
                <div
                  role="group"
                  aria-label={t("roster.filters.label")}
                  className="flex flex-col gap-2 sm:flex-row"
                >
                  <Select
                    value={positionFilter}
                    onValueChange={setPositionFilter}
                  >
                    <SelectTrigger
                      aria-label={t("roster.filters.position")}
                      className="w-full sm:w-44"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>
                        {t("roster.filters.allPositions")}
                      </SelectItem>
                      {positions
                        .slice()
                        .sort((left, right) =>
                          left.name.localeCompare(right.name, "id-ID"),
                        )
                        .map((position) => (
                          <SelectItem key={position.id} value={position.id}>
                            {position.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={stationFilter}
                    onValueChange={setStationFilter}
                  >
                    <SelectTrigger
                      aria-label={t("roster.filters.station")}
                      className="w-full sm:w-44"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>
                        {t("roster.filters.allStations")}
                      </SelectItem>
                      {stationOptions.map((stationId) => (
                        <SelectItem key={stationId} value={stationId}>
                          {stationName(stationId) ?? stationId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            />
          )}

          <SuggestionPanel
            suggestions={suggestions}
            employeesById={employeesById}
            templatesById={templatesById}
            onAccept={acceptSuggestion}
          />
        </>
      )}

      <PublishDialog
        open={publishOpen}
        onOpenChange={handlePublishOpenChange}
        range={range}
        shiftCount={rows.length}
        employeeCount={employeeCount}
        warningCount={compliance.total}
        pending={publish.isPending}
        error={publish.error}
        onConfirm={confirmPublish}
      />
    </div>
  );
}
