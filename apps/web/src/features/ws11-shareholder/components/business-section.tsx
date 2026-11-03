// "Kondisi bisnis" (PRD §3 F35, SH-01): official figures of the last CLOSED
// period, KPI month / year-to-date, and the running period labelled estimate.
// Related metrics share a StatStrip (DESIGN.md v3). No report links unless the
// caller holds the report's permission AND the route exists (DASH-01).
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import {
  Card,
  CardShell,
  CardShellFooter,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { useRouteAvailable } from "@/lib/use-route-available";
import type { DashboardLayout, DashboardTile } from "@starter/shared/dashboard";
import {
  closedPeriodOf,
  formatPeriod,
  isOfficial,
  KPI_MONTH_KEY,
  KPI_YTD_KEY,
  metricCell,
  metricName,
  permittedReportPath,
  RUNNING_ESTIMATE_METRICS,
  RUNNING_ESTIMATE_REPORT,
  runningPeriodOf,
  STRIP_CASH_KEYS,
  STRIP_RESULT_KEYS,
  tileOf,
  tilePeriod,
} from "../board.ts";
import type { BoardRun, ShareholderBoard } from "../hooks";
import { MetricValueView } from "./metric-value";
import { FinalityBadge, RegionFailure, isFailure } from "./region";

type Cell = { tile: DashboardTile; metricCode: string };

function cellsOf(layout: DashboardLayout, keys: readonly string[]): Cell[] {
  const cells: Cell[] = [];
  for (const key of keys) {
    const tile = tileOf(layout, key);
    if (tile === null || tile.kind !== "metric") continue;
    for (const metricCode of tile.metricCodes) cells.push({ tile, metricCode });
  }
  return cells;
}

function reportOf(tile: DashboardTile): string {
  return tile.kind === "metric" ? tile.reportCode : "";
}

function MissingValue() {
  return (
    <span className="type-heading font-normal text-muted-foreground">—</span>
  );
}

function useMetricLabel() {
  const t = useT();
  return (code: string, run: BoardRun): string => {
    const key = `shareholderHome.metrics.${code}`;
    const label = t(key as never);
    return label === key ? (metricName(run.result, code) ?? code) : label;
  };
}

/**
 * Drill-down link, or null. StatTile draws its chevron whenever `source` is
 * set, so the caller passes nothing (not an element rendering nothing) when
 * the caller may not open the report: no dead accent chevrons.
 */
function useSourceLink(permissions: readonly string[]) {
  const routeAvailable = useRouteAvailable();
  return (tile: DashboardTile): ReactNode => {
    const path = permittedReportPath(tile, permissions);
    if (path === null || !routeAvailable(path)) return undefined;
    return (
      <a
        href={path}
        className="font-semibold text-primary underline-offset-4 hover:underline"
      >
        {tile.title}
      </a>
    );
  };
}

function MetricTile({
  cell,
  board,
  permissions,
}: {
  cell: Cell;
  board: ShareholderBoard;
  permissions: readonly string[];
}) {
  const t = useT();
  const labelOf = useMetricLabel();
  const sourceOf = useSourceLink(permissions);
  const period = tilePeriod(board.layout, cell.tile);
  const run = board.run(reportOf(cell.tile), period);
  const label = labelOf(cell.metricCode, run);
  const periodText = formatPeriod(period);
  if (run.status === "loading")
    return (
      <StatTile
        label={label}
        value={<Skeleton className="h-7 w-24" />}
        context={periodText}
      />
    );
  if (isFailure(run.status))
    return (
      <StatTile
        label={label}
        value={<MissingValue />}
        context={t("shareholderHome.loadFailed")}
      />
    );
  const value = metricCell(run.result, cell.metricCode);
  const official = run.result !== null && isOfficial(run.result);
  return (
    <StatTile
      label={label}
      value={
        value === null ? <MissingValue /> : <MetricValueView value={value} />
      }
      context={
        value === null
          ? t("shareholderHome.noData")
          : official
            ? periodText
            : `${periodText} · ${t("shareholderHome.badge.estimate")}`
      }
      source={sourceOf(cell.tile)}
    />
  );
}

function Strip({
  label,
  cells,
  board,
  permissions,
}: {
  label: string;
  cells: Cell[];
  board: ShareholderBoard;
  permissions: readonly string[];
}): ReactNode {
  if (cells.length === 0) return null;
  const tiles = cells.map((cell) => (
    <MetricTile
      key={`${cell.tile.key}:${cell.metricCode}`}
      cell={cell}
      board={board}
      permissions={permissions}
    />
  ));
  if (cells.length === 1) return tiles[0];
  return (
    <StatStrip label={label} columns={Math.min(4, cells.length) as 2 | 3 | 4}>
      {tiles}
    </StatStrip>
  );
}

function KpiGroup({
  tileKey,
  title,
  board,
}: {
  tileKey: string;
  title: string;
  board: ShareholderBoard;
}) {
  const t = useT();
  const labelOf = useMetricLabel();
  const tile = tileOf(board.layout, tileKey);
  if (tile === null || tile.kind !== "metric") return null;
  const period = tilePeriod(board.layout, tile);
  const run = board.run(tile.reportCode, period);
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h4 className="text-sm font-semibold">{title}</h4>
        <span className="text-xs text-muted-foreground tabular">
          {run.result !== null && !isOfficial(run.result)
            ? `${formatPeriod(period)} · ${t("shareholderHome.badge.estimate")}`
            : formatPeriod(period)}
        </span>
      </div>
      {run.status === "loading" ? (
        <Skeleton className="h-16" />
      ) : isFailure(run.status) ? (
        <RegionFailure status={run.status} retry={run.retry} />
      ) : (
        <dl className="grid gap-1.5">
          {tile.metricCodes.map((code) => {
            const value = metricCell(run.result, code);
            return (
              <div
                key={code}
                className="flex items-baseline justify-between gap-3 border-b-(length:--border-w) py-1.5 last:border-0"
              >
                <dt className="text-sm text-muted-foreground">
                  {labelOf(code, run)}
                </dt>
                <dd className="text-sm font-semibold">
                  {value === null ? (
                    <span className="text-muted-foreground">
                      {t("shareholderHome.noData")}
                    </span>
                  ) : (
                    <MetricValueView value={value} size="md" />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

function RunningEstimate({ board }: { board: ShareholderBoard }) {
  const t = useT();
  const labelOf = useMetricLabel();
  const period = runningPeriodOf(board.layout);
  if (period === null) return null;
  const run = board.run(RUNNING_ESTIMATE_REPORT, period);
  return (
    <CardShell>
      <Card className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t("shareholderHome.business.runningTitle")}</CardTitle>
          {/* SH-01: the running period is never presented as official. */}
          <FinalityBadge official={false} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t("shareholderHome.business.runningPeriod", {
            period: formatPeriod(period),
          })}
        </p>
        {run.status === "loading" ? (
          <Skeleton className="h-20" />
        ) : isFailure(run.status) ? (
          <RegionFailure status={run.status} retry={run.retry} />
        ) : run.status === "empty" ? (
          <p className="text-sm text-muted-foreground">
            {t("shareholderHome.noData")}
          </p>
        ) : (
          <dl className="grid gap-1.5">
            {RUNNING_ESTIMATE_METRICS.map((code) => {
              const value = metricCell(run.result, code);
              if (value === null) return null;
              return (
                <div
                  key={code}
                  className="flex items-baseline justify-between gap-3 border-b-(length:--border-w) py-1.5 last:border-0"
                >
                  <dt className="text-sm text-muted-foreground">
                    {labelOf(code, run)}
                  </dt>
                  <dd className="text-sm font-semibold">
                    <MetricValueView value={value} size="md" />
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </Card>
      <CardShellFooter>
        <span>{t("shareholderHome.business.runningHint")}</span>
      </CardShellFooter>
    </CardShell>
  );
}

export function BusinessSection({
  board,
  permissions,
}: {
  board: ShareholderBoard;
  permissions: readonly string[];
}) {
  const t = useT();
  const { layout } = board;
  // One StatStrip for the closed period (DESIGN.md §12 dashboard: one strip):
  // results first, then cash and guests.
  const stripCells = cellsOf(layout, [
    ...STRIP_RESULT_KEYS,
    ...STRIP_CASH_KEYS,
  ]);
  const closed = closedPeriodOf(layout);

  const runs = stripCells.map((cell) =>
    board.run(reportOf(cell.tile), tilePeriod(layout, cell.tile)),
  );
  const allEmpty =
    runs.length > 0 && runs.every((run) => run.status === "empty");
  const official =
    runs.length > 0 &&
    runs.every((run) => run.result !== null && isOfficial(run.result));
  const loaded = runs.every(
    (run) => run.status !== "loading" && !isFailure(run.status),
  );

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title">
            {t("shareholderHome.business.closedTitle")}
          </h2>
          {loaded && !allEmpty && <FinalityBadge official={official} />}
        </div>
        <p className="text-sm text-muted-foreground tabular">
          {t("shareholderHome.business.closedPeriod", {
            period: formatPeriod(closed),
          })}
        </p>
        <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
          {loaded && !allEmpty && !official
            ? t("shareholderHome.business.notOfficial")
            : t("shareholderHome.business.closedHint")}
        </p>
      </div>

      {allEmpty ? (
        <CardShell>
          <Card>
            <EmptyState
              title={t("shareholderHome.business.emptyTitle")}
              description={t("shareholderHome.business.emptyHint")}
            />
          </Card>
        </CardShell>
      ) : (
        <>
          <Strip
            label={t("shareholderHome.business.stripLabel")}
            cells={stripCells}
            board={board}
            permissions={permissions}
          />
          {(tileOf(layout, KPI_MONTH_KEY) || tileOf(layout, KPI_YTD_KEY)) && (
            <CardShell>
              <Card className="gap-4">
                <CardTitle>{t("shareholderHome.business.kpiTitle")}</CardTitle>
                <div className="grid gap-5 md:grid-cols-2">
                  <KpiGroup
                    tileKey={KPI_MONTH_KEY}
                    title={t("shareholderHome.business.kpiMonth")}
                    board={board}
                  />
                  <KpiGroup
                    tileKey={KPI_YTD_KEY}
                    title={t("shareholderHome.business.kpiYtd")}
                    board={board}
                  />
                </div>
              </Card>
            </CardShell>
          )}
        </>
      )}

      <RunningEstimate board={board} />
    </div>
  );
}
