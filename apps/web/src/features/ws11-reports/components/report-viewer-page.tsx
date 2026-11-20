// The generic report viewer (WS-11 FE, bead legend-j815; PRD v1.7 §3 F36
// "Laporan", "Ekspor"; DASH-02, DASH-04). A route file passes only the report
// code; the definition (GET /api/reports/:code) decides the periods, splits,
// export formats and the personal-data rules. Numbers come from running the
// report (POST /api/reports/run), so a dashboard tile and this page read the
// same run (DASH-02). The shell topbar owns the page title (DESIGN.md v3).
import { useState } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  ArrowLeft,
  CalendarDays,
  Download,
  RotateCw,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import {
  REPORT_EXPORT_PERMISSION,
  REPORT_FAMILY_INFO,
  REPORT_PERSONAL_DATA_EXPORT_PERMISSION,
  type ReportResult,
} from "@starter/shared/dashboard";
import {
  formatBusinessDate,
  formatOutletTime,
} from "@/features/ws11-owner-dashboard/board";
import { StatMetricValue } from "@/features/ws11-owner-dashboard/components/metric-display";
import {
  useBusinessScope,
  useReportDefinition,
  useReportRun,
  useReportSearch,
} from "../hooks";
import {
  buildRunInput,
  buildTotalsInput,
  clockBusinessDate,
  isChartable,
  isResultEmpty,
  reportExportOffered,
  reportFamilyHasData,
  resolvePeriod,
  resolveSplit,
  resultFinality,
  selectionIsPersonal,
  type ReportQuerySelection,
} from "../lib";
import { ExportDialog } from "./export-dialog";
import { ReportChart } from "./report-chart";
import { ReportFilters } from "./report-filters";
import { ReportTable } from "./report-table";

function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

function PageSkeleton() {
  const t = useT();
  return (
    <div className="grid gap-5" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-16" />
      <Skeleton className="h-28" />
      <Skeleton className="h-64" />
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      to={"/reports" as "/"}
      className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("reportViewer.backToCatalog")}
    </Link>
  );
}

const PROBLEM = {
  offline: {
    title: "reportViewer.problem.offline.title",
    hint: "reportViewer.problem.offline.hint",
    retry: true,
  },
  notFound: {
    title: "reportViewer.problem.notFound.title",
    hint: "reportViewer.problem.notFound.hint",
    retry: false,
  },
  forbidden: {
    title: "reportViewer.problem.forbidden.title",
    hint: "reportViewer.problem.forbidden.hint",
    retry: false,
  },
  error: {
    title: "reportViewer.problem.error.title",
    hint: "reportViewer.problem.error.hint",
    retry: true,
  },
} as const;

function DefinitionProblem({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  const code = error instanceof ApiError ? error.code : "";
  const offline = isOffline(error);
  const view = offline
    ? PROBLEM.offline
    : code === "REPORT_NOT_FOUND"
      ? PROBLEM.notFound
      : code === "REPORT_NOT_PERMITTED"
        ? PROBLEM.forbidden
        : PROBLEM.error;
  return (
    <div className="grid gap-4">
      <BackLink />
      <CardShell>
        <CardShellBody>
          <ErrorState
            icon={offline ? WifiOff : undefined}
            title={t(view.title)}
            description={t(view.hint)}
            onRetry={view.retry ? onRetry : undefined}
          />
        </CardShellBody>
      </CardShell>
    </div>
  );
}

function SummaryStrip({ result }: { result: ReportResult }) {
  const t = useT();
  const row = result.rows[0];
  if (!row || isResultEmpty(result)) return null;
  const tiles = result.definitions.slice(0, 4);
  return (
    <StatStrip
      label={t("reportViewer.summary.label")}
      columns={Math.min(4, Math.max(2, tiles.length)) as 2 | 3 | 4}
    >
      {tiles.map((definition) => {
        const cell = row.values.find(
          (value) => value.metricCode === definition.code,
        );
        return (
          <StatTile
            key={definition.code}
            label={definition.name}
            value={
              cell?.value ? (
                <StatMetricValue value={cell.value} />
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
            context={t("reportViewer.summary.context")}
          />
        );
      })}
    </StatStrip>
  );
}

export function ReportViewerPage({ reportCode }: { reportCode: string }) {
  const t = useT();
  const definitionQuery = useReportDefinition(reportCode);
  const scope = useBusinessScope();
  const [search, update] = useReportSearch();
  const [exportOpen, setExportOpen] = useState(false);
  const context = useRouteContext({ strict: false }) as { access?: AreaAccess };

  const definition = definitionQuery.data;
  const businessDate =
    scope.data?.businessDate ?? (scope.isError ? clockBusinessDate() : null);
  const period = definition
    ? resolvePeriod(definition, search, businessDate)
    : null;
  const split = definition ? resolveSplit(definition, search) : null;
  const outletIds = search.outletId ?? [];
  // A family without server data yet is never run (legend-x73li).
  const comingSoon =
    definition !== undefined &&
    !reportFamilyHasData(definition.family, { mock: API_MOCK });
  const selection: ReportQuerySelection | null =
    period && !comingSoon
      ? { period: period.range, outletIds, groupBy: split }
      : null;

  const run = useReportRun(
    selection ? buildRunInput(reportCode, selection) : null,
  );
  const totals = useReportRun(
    selection && split !== null
      ? buildTotalsInput(reportCode, selection)
      : null,
  );

  if (definitionQuery.isError)
    return (
      <DefinitionProblem
        error={definitionQuery.error}
        onRetry={() => void definitionQuery.refetch()}
      />
    );
  if (!definition) return <PageSkeleton />;
  if (comingSoon)
    return (
      <div className="grid gap-4">
        <BackLink />
        <CardShell>
          <CardShellBody>
            <EmptyState
              title={`${definition.name} · ${t("reportViewer.catalog.soon")}`}
              description={definition.description}
            />
          </CardShellBody>
        </CardShell>
      </div>
    );

  const personal = selectionIsPersonal(definition, split);
  const result = run.data ?? null;
  const finality = result ? resultFinality(result) : "none";
  const empty = result !== null && isResultEmpty(result);
  const offline = run.isError && isOffline(run.error);
  const summary = split === null ? result : (totals.data ?? null);
  const canExport = context.access
    ? holdsAny(context.access, [
        personal
          ? REPORT_PERSONAL_DATA_EXPORT_PERMISSION
          : REPORT_EXPORT_PERMISSION,
      ])
    : false;
  const exportOffered = reportExportOffered({ mock: API_MOCK });
  const refreshing = run.isFetching || totals.isFetching;
  const refresh = () => {
    void run.refetch();
    if (split !== null) void totals.refetch();
  };
  const tableState = run.isError
    ? "error"
    : !result
      ? "loading"
      : empty
        ? "empty"
        : "ready";
  const meta = period
    ? [
        period.range.startDate === period.range.endDate
          ? formatBusinessDate(period.range.startDate)
          : t("reportViewer.periodRange", {
              from: formatBusinessDate(period.range.startDate),
              to: formatBusinessDate(period.range.endDate),
            }),
        ...(result
          ? [
              t("reportViewer.updatedAt", {
                time: formatOutletTime(result.generatedAt),
              }),
            ]
          : []),
      ].join(" · ")
    : "";

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="grid gap-3">
        <BackLink />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 max-w-3xl">
            <h2 className="type-title">{definition.name}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {definition.description}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={refreshing}
              onClick={refresh}
            >
              <RotateCw aria-hidden="true" />
              {t("reportViewer.refresh")}
            </Button>
            {exportOffered && (
              <Button
                type="button"
                size="sm"
                disabled={!canExport || !selection || empty}
                title={canExport ? undefined : t("reportViewer.exportDenied")}
                onClick={() => setExportOpen(true)}
              >
                <Download aria-hidden="true" />
                {t("reportViewer.export.open")}
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone="neutral">
            {REPORT_FAMILY_INFO[definition.family].label}
          </Badge>
          {finality === "estimate" && (
            <Badge tone="info">{t("reportViewer.finality.estimate")}</Badge>
          )}
          {finality === "final" && (
            <Badge tone="success">{t("reportViewer.finality.final")}</Badge>
          )}
          {personal && (
            <Badge tone="warning">
              <ShieldAlert aria-hidden="true" />
              {t("reportViewer.personalBadge")}
            </Badge>
          )}
          {meta && (
            <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground tabular">
              <CalendarDays
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0">{meta}</span>
            </p>
          )}
        </div>
        {finality === "estimate" && (
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
            {definition.closedPeriodOnly
              ? t("reportViewer.finality.estimateClosedOnly")
              : t("reportViewer.finality.estimateHint")}
          </p>
        )}
        {finality === "final" && (
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
            {t("reportViewer.finality.finalHint")}
          </p>
        )}
        {personal && (
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
            {t("reportViewer.personalHint")}
          </p>
        )}
      </div>

      <ReportFilters
        definition={definition}
        period={period}
        split={split}
        outletIds={outletIds}
        availableOutlets={scope.data?.availableOutlets ?? []}
        onChange={update}
        onReset={() =>
          update({
            startDate: undefined,
            endDate: undefined,
            preset: undefined,
            groupBy: undefined,
            outletId: undefined,
          })
        }
      />

      {offline ? (
        <CardShell>
          <CardShellBody>
            <ErrorState
              icon={WifiOff}
              title={t("reportViewer.offline.title")}
              description={t("reportViewer.offline.hint")}
              onRetry={refresh}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <>
          {summary && <SummaryStrip result={summary} />}
          {result && !empty && isChartable(result) && (
            <ReportChart result={result} />
          )}
          <ReportTable
            result={result}
            state={tableState}
            onRetry={refresh}
            empty={{
              title: t("reportViewer.empty.title"),
              description: t("reportViewer.empty.hint"),
            }}
          />
        </>
      )}

      {selection && exportOffered && (
        <ExportDialog
          // A new selection starts a new export attempt.
          key={`${selection.period.startDate}|${selection.period.endDate}|${selection.groupBy ?? ""}`}
          open={exportOpen}
          onOpenChange={setExportOpen}
          definition={definition}
          selection={selection}
          personal={personal}
        />
      )}
    </div>
  );
}
