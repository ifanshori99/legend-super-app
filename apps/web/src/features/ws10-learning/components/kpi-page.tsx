// /kelola/kpi — KPI reviews per cycle and period (PRD v1.7 §3 F32 "Kinerja":
// scores, status and source), with the per-indicator detail in a dialog.
//
// The contract sends scores (0–100) and actual values but no definition list,
// so indicator names/targets come from the mock-only read model; against the
// real API the dialog says the detail is not available yet instead of guessing
// a target (see read-model.ts).
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@starter/shared/i18n";
import type { KpiReview, KpiReviewCycle } from "@starter/shared/hris";
import { useEmployees, useKpiReviews, usePositions } from "../hooks";
import {
  achievementPercent,
  formatBusinessDate,
  formatDecimal,
  formatPeriod,
  formatWithUnit,
  periodOf,
  reviewAverageScore,
  reviewSources,
} from "../lib";
import { fixtureKpiDefinitions } from "../read-model";
import { ScoreBar } from "./score-bar";

export function KpiPage() {
  const t = useT();
  const reviewsQuery = useKpiReviews();
  const employeesQuery = useEmployees();
  const positionsQuery = usePositions();

  const [cycle, setCycle] = React.useState<KpiReviewCycle>("monthly");
  const [period, setPeriod] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const definitions = fixtureKpiDefinitions();
  const definitionsById = React.useMemo(
    () =>
      definitions === null
        ? null
        : new Map(definitions.map((definition) => [definition.id, definition])),
    [definitions],
  );
  const employees = React.useMemo(
    () => employeesQuery.data?.data ?? [],
    [employeesQuery.data],
  );
  const positions = React.useMemo(
    () => positionsQuery.data?.data ?? [],
    [positionsQuery.data],
  );
  const employeesById = React.useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );
  const positionsById = React.useMemo(
    () => new Map(positions.map((position) => [position.id, position])),
    [positions],
  );

  const reviews = React.useMemo(
    () =>
      (reviewsQuery.data?.data ?? []).filter(
        (review) =>
          review.cycle === cycle &&
          (period === "" || periodOf(review) === period),
      ),
    [reviewsQuery.data, cycle, period],
  );

  const employeeName = (review: Pick<KpiReview, "employeeId">) =>
    employeesById.get(review.employeeId)?.fullName ??
    t("learning.kpi.noEmployee");
  const positionName = (review: Pick<KpiReview, "employeeId">) => {
    const positionId = employeesById.get(review.employeeId)?.positionId;
    return (
      (positionId === null || positionId === undefined
        ? undefined
        : positionsById.get(positionId)?.name) ?? t("learning.kpi.noPosition")
    );
  };

  const searchText = search.trim().toLocaleLowerCase("id-ID");
  const visible = React.useMemo(
    () =>
      searchText === ""
        ? reviews
        : reviews.filter((review) => {
            const employee = employeesById.get(review.employeeId);
            const position =
              employee?.positionId === null ||
              employee?.positionId === undefined
                ? ""
                : (positionsById.get(employee.positionId)?.name ?? "");
            return (
              (employee?.fullName ?? "")
                .toLocaleLowerCase("id-ID")
                .includes(searchText) ||
              position.toLocaleLowerCase("id-ID").includes(searchText)
            );
          }),
    [reviews, searchText, employeesById, positionsById],
  );

  const submitted = reviews.filter(
    (review) => review.status === "submitted",
  ).length;
  const average =
    reviews.length === 0
      ? null
      : Math.round(
          reviews.reduce((sum, review) => sum + reviewAverageScore(review), 0) /
            reviews.length,
        );
  const periodContext =
    period === ""
      ? t("learning.kpi.metric.allPeriods")
      : t("learning.kpi.metric.context", { period: formatPeriod(period) });

  const state: DataState =
    reviewsQuery.isPending ||
    employeesQuery.isPending ||
    positionsQuery.isPending
      ? "loading"
      : reviewsQuery.isError || employeesQuery.isError || positionsQuery.isError
        ? "error"
        : reviews.length === 0
          ? "empty"
          : "ready";

  const selected =
    selectedId === null
      ? null
      : (reviews.find((review) => review.id === selectedId) ?? null);

  return (
    <div className="grid min-w-0 gap-4">
      <StatStrip label={t("learning.kpi.summaryLabel")} columns={3}>
        <StatTile
          label={t("learning.kpi.metric.reviews")}
          value={
            <span className="tabular">{formatNumber(reviews.length)}</span>
          }
          context={periodContext}
        />
        <StatTile
          label={t("learning.kpi.metric.submitted")}
          value={<span className="tabular">{formatNumber(submitted)}</span>}
          context={periodContext}
        />
        <StatTile
          label={t("learning.kpi.metric.average")}
          value={
            <span className="tabular">
              {average === null
                ? t("learning.common.none")
                : formatNumber(average)}
            </span>
          }
          context={periodContext}
        />
      </StatStrip>

      <DataTableShell
        title={t("learning.kpi.tableTitle")}
        description={t("learning.kpi.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("learning.kpi.table.employee"),
        }}
        actions={
          <>
            <SegmentedControl
              value={cycle}
              onValueChange={setCycle}
              label={t("learning.kpi.cycleLabel")}
              options={[
                {
                  value: "monthly",
                  label: t("learning.kpi.cycle.monthly"),
                },
                {
                  value: "quarterly",
                  label: t("learning.kpi.cycle.quarterly"),
                },
              ]}
            />
            <Input
              type="month"
              value={period}
              aria-label={t("learning.kpi.periodLabel")}
              onChange={(event) => setPeriod(event.target.value)}
              className="h-control-sm w-full sm:w-44"
            />
          </>
        }
        onRetry={() => {
          void reviewsQuery.refetch();
          void employeesQuery.refetch();
          void positionsQuery.refetch();
        }}
        empty={{
          title: t("learning.kpi.emptyTitle"),
          description: t("learning.kpi.emptyHint"),
        }}
        noResults={visible.length === 0 && state === "ready"}
        rowCount={visible.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("learning.kpi.table.employee")}</TableHead>
              <TableHead>{t("learning.kpi.table.position")}</TableHead>
              <TableHead>{t("learning.kpi.table.period")}</TableHead>
              <TableHead>{t("learning.kpi.table.score")}</TableHead>
              <TableHead>{t("learning.kpi.table.status")}</TableHead>
              <TableHead>{t("learning.kpi.table.source")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("learning.kpi.table.action")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((review) => {
              const score = reviewAverageScore(review);
              const sources = reviewSources(review, definitions);
              return (
                <TableRow key={review.id}>
                  <TableCell>
                    <p className="font-medium">{employeeName(review)}</p>
                    <p className="text-xs text-muted-foreground tabular">
                      {employeesById.get(review.employeeId)?.employeeNo ??
                        t("learning.common.none")}
                    </p>
                  </TableCell>
                  <TableCell>{positionName(review)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {formatPeriod(periodOf(review))}
                  </TableCell>
                  <TableCell>
                    <ScoreBar
                      value={score}
                      label={t("learning.kpi.scoreBar", { score })}
                      fallback={t("learning.common.none")}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusPill
                      status={
                        review.status === "submitted" ? "success" : "warning"
                      }
                    >
                      {t(
                        review.status === "submitted"
                          ? "learning.kpi.status.submitted"
                          : "learning.kpi.status.draft",
                      )}
                    </StatusPill>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {sources === null
                        ? t("learning.common.none")
                        : sources.map((source) => (
                            <Badge
                              key={source}
                              tone={source === "system" ? "neutral" : "brand"}
                            >
                              {t(
                                source === "system"
                                  ? "learning.kpi.source.system"
                                  : "learning.kpi.source.manager",
                              )}
                            </Badge>
                          ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedId(review.id)}
                    >
                      {t("learning.kpi.open")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {selected !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("learning.kpi.detailTitle")}</DialogTitle>
              <DialogDescription>
                {t("learning.common.meta", {
                  first: t("learning.kpi.detailSubtitle", {
                    employee: employeeName(selected),
                    position: positionName(selected),
                  }),
                  second: t("learning.kpi.detailPeriod", {
                    period: formatPeriod(periodOf(selected)),
                  }),
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <div className="flex flex-wrap items-end justify-between gap-3 rounded-container bg-surface-2 p-3">
                <div>
                  <p className="type-eyebrow text-muted-foreground">
                    {t("learning.kpi.total")}
                  </p>
                  <p className="type-title tabular">
                    {formatNumber(reviewAverageScore(selected))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("learning.kpi.totalHint")}
                  </p>
                </div>
                <ScoreBar
                  value={reviewAverageScore(selected)}
                  label={t("learning.kpi.scoreBar", {
                    score: reviewAverageScore(selected),
                  })}
                  fallback={t("learning.common.none")}
                />
              </div>

              <h3 className="type-title">{t("learning.kpi.scoresTitle")}</h3>
              {definitionsById === null ? (
                <p className="rounded-container bg-surface-2 p-3 text-sm leading-5">
                  {t("learning.kpi.definitionsUnavailable")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("learning.kpi.definition")}</TableHead>
                      <TableHead>{t("learning.kpi.target")}</TableHead>
                      <TableHead>{t("learning.kpi.actual")}</TableHead>
                      <TableHead>{t("learning.kpi.score")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.scores.map((score) => {
                      const definition = definitionsById.get(
                        score.kpiDefinitionId,
                      );
                      const target =
                        definition === undefined || definition.target === null
                          ? t("learning.common.none")
                          : formatWithUnit(definition.target, definition.unit);
                      const actual =
                        definition === undefined
                          ? formatDecimal(score.actual)
                          : formatWithUnit(score.actual, definition.unit);
                      const achievement =
                        definition === undefined
                          ? null
                          : achievementPercent(
                              definition.direction,
                              definition.target,
                              score.actual,
                            );
                      return (
                        <TableRow key={score.kpiDefinitionId}>
                          <TableCell>
                            <p className="font-medium">
                              {definition?.name ?? t("learning.common.none")}
                            </p>
                            {definition && (
                              <p className="text-xs text-muted-foreground">
                                {t(
                                  definition.direction === "higher_is_better"
                                    ? "learning.kpi.direction.higher"
                                    : "learning.kpi.direction.lower",
                                )}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="tabular whitespace-nowrap">
                            {target}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <span className="tabular">{actual}</span>
                            <ScoreBar
                              value={achievement}
                              label={t("learning.kpi.achievementBar", {
                                percent: achievement ?? 0,
                              })}
                              fallback={t("learning.kpi.achievementUnknown")}
                              showValue={false}
                              className="mt-1"
                            />
                          </TableCell>
                          <TableCell>
                            <ScoreBar
                              value={score.score}
                              label={t("learning.kpi.scoreBar", {
                                score: score.score,
                              })}
                              fallback={t("learning.common.none")}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              <p className="text-xs text-muted-foreground">
                {t("learning.kpi.detailPeriod", {
                  period: `${formatBusinessDate(selected.periodStart)}–${formatBusinessDate(selected.periodEnd)}`,
                })}
              </p>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t("common.close")}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
