// Live preview of the builder query (PRD v1.7 §3 F36): a chart and the table
// of the result the preview endpoint returns. The same ReportResult shape
// feeds the viewer, the export and Tanya AI (DASH-02), so a cell here is the
// number those show. Loading, empty, error and offline are distinct states.
import { useId, useMemo, useState } from "react";
import { cn } from "cn";
import { ChartNoAxesColumn, Info, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ReportResult } from "@starter/shared/dashboard";
import { isOfflineError, type BuilderIssue } from "../builder";
import {
  dimensionLabel,
  dimensionValueLabel,
  formatDateTime,
  formatMetricValue,
  formatPeriod,
  metricNumber,
  reportErrorText,
} from "../format";
import { StepCard } from "./step-card";

export type PreviewState =
  | { status: "invalid"; issues: BuilderIssue[] }
  | { status: "loading" }
  | { status: "error"; error: unknown; retry: () => void }
  | { status: "ready"; result: ReportResult };

function IssueList({ issues }: { issues: readonly BuilderIssue[] }) {
  const t = useT();
  return (
    <ul className="grid gap-1.5" aria-label={t("reportBuilder.issues.title")}>
      {issues.map((issue) => (
        <li
          key={issue.kind === "draft" ? issue.key : issue.code}
          className="flex items-start gap-2 text-sm leading-5 text-muted-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {issue.kind === "draft"
            ? t(`reportBuilder.issues.draft.${issue.key}`)
            : t(`reportBuilder.errors.${issue.code}`)}
        </li>
      ))}
    </ul>
  );
}

/** Horizontal bars for one metric across the rows; the table has the exact figures. */
function ResultChart({
  result,
  outletNames,
}: {
  result: ReportResult;
  outletNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const selectId = useId();
  const [metricIndex, setMetricIndex] = useState(0);
  const index = Math.min(metricIndex, result.definitions.length - 1);
  const definition = result.definitions[index];
  const bars = useMemo(
    () =>
      result.rows.slice(0, 12).map((row) => {
        const cell = row.values[index];
        return {
          label: row.dimensions
            .map((dimension) =>
              dimensionValueLabel(
                t,
                dimension.key,
                dimension.value,
                outletNames,
              ),
            )
            .join(" · "),
          value: cell?.value ?? null,
        };
      }),
    [result.rows, index, outletNames, t],
  );
  const max = Math.max(
    1,
    ...bars.map((bar) => (bar.value ? Math.abs(metricNumber(bar.value)) : 0)),
  );
  if (definition === undefined) return null;

  return (
    <figure className="grid gap-3">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={selectId} className="text-sm font-medium">
          {t("reportBuilder.preview.chartMetric")}
        </label>
        <Select
          value={String(index)}
          onValueChange={(value) => setMetricIndex(Number(value))}
        >
          <SelectTrigger id={selectId} className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {result.definitions.map((item, position) => (
              <SelectItem key={item.code} value={String(position)}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </figcaption>
      <ul
        role="img"
        aria-label={t("reportBuilder.preview.chartLabel", {
          metric: definition.name,
        })}
        className="grid gap-2"
      >
        {bars.map((bar, position) => (
          <li
            key={`${bar.label}-${position}`}
            className="grid grid-cols-[minmax(4.5rem,8rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_auto]"
          >
            <span className="truncate text-sm">{bar.label}</span>
            <span className="h-3 overflow-hidden rounded-full bg-surface-3">
              <span
                className="block h-full rounded-full bg-primary"
                style={{
                  width: `${bar.value ? Math.max(2, (Math.abs(metricNumber(bar.value)) / max) * 100) : 0}%`,
                }}
              />
            </span>
            <span className="col-start-2 text-xs tabular text-muted-foreground sm:col-start-3 sm:text-sm sm:text-foreground">
              {bar.value ? formatMetricValue(bar.value, t) : "—"}
            </span>
          </li>
        ))}
      </ul>
      {result.rows.length > bars.length && (
        <p className="text-xs text-muted-foreground">
          {t("reportBuilder.preview.chartTruncated", { count: bars.length })}
        </p>
      )}
    </figure>
  );
}

function ResultTable({
  result,
  outletNames,
}: {
  result: ReportResult;
  outletNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-control border-(length:--border-w)">
      <Table>
        <TableHeader>
          <TableRow>
            {result.groupBy.map((key) => (
              <TableHead key={key}>{dimensionLabel(t, key)}</TableHead>
            ))}
            {result.definitions.map((definition) => (
              <TableHead key={definition.code} numeric>
                {definition.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.dimensions.map((dimension) => (
                <TableCell key={dimension.key}>
                  {dimensionValueLabel(
                    t,
                    dimension.key,
                    dimension.value,
                    outletNames,
                  )}
                </TableCell>
              ))}
              {row.values.map((cell) => (
                <TableCell key={cell.metricCode} numeric>
                  {cell.value ? (
                    formatMetricValue(cell.value, t)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PreviewPanel({
  state,
  outletNames,
}: {
  state: PreviewState;
  outletNames: ReadonlyMap<string, string>;
}) {
  const t = useT();

  let body;
  if (state.status === "invalid") {
    body = (
      <div className="grid gap-3">
        <EmptyState
          className="py-6"
          icon={ChartNoAxesColumn}
          title={t("reportBuilder.preview.invalidTitle")}
          description={t("reportBuilder.preview.invalidHint")}
        />
        <IssueList issues={state.issues} />
      </div>
    );
  } else if (state.status === "loading") {
    body = (
      <div aria-busy="true" className="grid gap-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (state.status === "error") {
    body = isOfflineError(state.error) ? (
      <ErrorState
        icon={WifiOff}
        title={t("reportBuilder.offline.title")}
        description={t("reportBuilder.offline.hint")}
        onRetry={state.retry}
      />
    ) : (
      <ErrorState
        title={t("reportBuilder.preview.errorTitle")}
        description={reportErrorText(t, state.error)}
        onRetry={state.retry}
      />
    );
  } else if (state.result.rows.length === 0) {
    body = (
      <EmptyState
        className="py-6"
        title={t("reportBuilder.preview.emptyTitle")}
        description={t("reportBuilder.preview.emptyHint")}
      />
    );
  } else {
    const { result } = state;
    const estimate = result.rows.some((row) =>
      row.values.some((cell) => cell.finality === "estimate"),
    );
    body = (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm leading-5 text-muted-foreground">
          <Badge tone={estimate ? "info" : "success"}>
            {estimate
              ? t("reportBuilder.preview.estimate")
              : t("reportBuilder.preview.final")}
          </Badge>
          <span className="tabular">{formatPeriod(result.period)}</span>
          <span className="tabular">
            {t("reportBuilder.preview.generatedAt", {
              time: formatDateTime(result.generatedAt),
            })}
          </span>
        </div>
        {estimate && (
          <p className="text-xs leading-5 text-muted-foreground">
            {t("reportBuilder.preview.estimateHint")}
          </p>
        )}
        {result.groupBy.length > 0 && (
          <ResultChart result={result} outletNames={outletNames} />
        )}
        <ResultTable result={result} outletNames={outletNames} />
        <p className={cn("text-xs text-muted-foreground")}>
          {t("reportBuilder.preview.rowCount", { count: result.rows.length })}
        </p>
      </div>
    );
  }

  // One short sentence is announced per state change; the table itself is
  // not a live region, or a screen reader would re-read every row. The
  // sentences differ from the visible titles so text lookups stay unique.
  const announcement =
    state.status === "loading"
      ? t("reportBuilder.preview.loading")
      : state.status === "invalid"
        ? t("reportBuilder.preview.announceInvalid")
        : state.status === "error"
          ? isOfflineError(state.error)
            ? t("reportBuilder.preview.announceOffline")
            : t("reportBuilder.preview.announceError")
          : state.result.rows.length === 0
            ? t("reportBuilder.preview.announceEmpty")
            : t("reportBuilder.preview.announceReady", {
                count: state.result.rows.length,
              });

  return (
    <StepCard
      title={t("reportBuilder.preview.title")}
      hint={t("reportBuilder.preview.hint")}
    >
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {body}
    </StepCard>
  );
}
