// "/reports/builder" — the report builder on the metric layer (PRD v1.7 §3
// F36). Four steps (metric, split, filter, period), a live preview through the
// builder preview endpoint, save, and email schedules. The shell, density and
// area guard come from the kelola layout; this file owns the page body.
import { useMemo, useState } from "react";
import { WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { useOnline } from "@/lib/use-online";
import type { SavedReport } from "@starter/shared/dashboard";
import {
  draftHasPersonalData,
  emptyDraft,
  queryToDraft,
  reconcileDraft,
  todayIn,
  usableMetrics,
  validateDraft,
  type BuilderDraft,
} from "../builder";
import { dimensionLabel } from "../format";
import { useBuilderOutlets, useDebounced, usePreview } from "../hooks";
import {
  DimensionStep,
  FilterStep,
  MetricStep,
  OutletScope,
  PeriodStep,
} from "./config-steps";
import { PreviewPanel, type PreviewState } from "./preview-panel";
import { SavePanel } from "./save-panel";
import { SavedReportsPanel } from "./saved-reports";
import { StepCard } from "./step-card";

export function ReportBuilderPage({
  permissions,
}: {
  permissions: readonly string[];
}) {
  const t = useT();
  const online = useOnline();
  const outletsQuery = useBuilderOutlets();
  const outlets = useMemo(() => outletsQuery.data ?? [], [outletsQuery.data]);
  // The first outlet's time zone decides the business date.
  const timeZone = outlets[0]?.timeZone;
  const today = useMemo(() => todayIn(timeZone), [timeZone]);
  const metrics = useMemo(() => usableMetrics(permissions), [permissions]);
  const outletNames = useMemo(
    () => new Map(outlets.map((outlet) => [outlet.id, outlet.name] as const)),
    [outlets],
  );

  const [draft, setDraft] = useState<BuilderDraft>(() =>
    emptyDraft(todayIn(undefined)),
  );
  const [loaded, setLoaded] = useState<SavedReport | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);

  const toggleMetric = (code: string) => {
    const metricCodes = draft.metricCodes.includes(code)
      ? draft.metricCodes.filter((item) => item !== code)
      : [...draft.metricCodes, code];
    const next = reconcileDraft({ ...draft, metricCodes });
    setDraft(next.draft);
    setDropped(next.dropped);
  };
  const change = (next: BuilderDraft) => {
    setDraft(next);
    setDropped([]);
  };

  const validation = useMemo(() => validateDraft(draft), [draft]);
  const validQuery = validation.ok ? validation.query : null;
  // Typing a filter value must not fire a request per keystroke.
  const settledQuery = useDebounced(validQuery, 400);
  const preview = usePreview(settledQuery);

  const previewState: PreviewState = !validation.ok
    ? { status: "invalid", issues: validation.issues }
    : preview.isError
      ? {
          status: "error",
          error: preview.error,
          retry: () => void preview.refetch(),
        }
      : preview.data === undefined || settledQuery !== validQuery
        ? { status: "loading" }
        : { status: "ready", result: preview.data };

  const open = (report: SavedReport) => {
    setLoaded(report);
    setDraft(queryToDraft(report.query));
    setDropped([]);
  };

  return (
    <div className="grid gap-5">
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        {t("reportBuilder.description")}
      </p>

      {!online && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-container bg-warning-subtle p-3 text-sm leading-5 text-warning"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="grid gap-0.5">
            <p className="font-semibold">{t("reportBuilder.offline.title")}</p>
            <p>{t("reportBuilder.offline.hint")}</p>
          </div>
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-5">
          <StepCard
            step={1}
            title={t("reportBuilder.steps.metric.title")}
            hint={t("reportBuilder.steps.metric.hint")}
          >
            <MetricStep
              draft={draft}
              metrics={metrics}
              onToggle={toggleMetric}
            />
          </StepCard>
          <StepCard
            step={2}
            title={t("reportBuilder.steps.dimension.title")}
            hint={t("reportBuilder.steps.dimension.hint")}
          >
            <DimensionStep draft={draft} metrics={metrics} onChange={change} />
            {dropped.length > 0 && (
              <p
                role="status"
                className="text-sm leading-5 text-muted-foreground"
              >
                {t("reportBuilder.dropped", {
                  names: dropped
                    .map((key) => dimensionLabel(t, key))
                    .join(", "),
                })}
              </p>
            )}
          </StepCard>
          <StepCard
            step={3}
            title={t("reportBuilder.steps.filter.title")}
            hint={t("reportBuilder.steps.filter.hint")}
          >
            <FilterStep draft={draft} onChange={change} />
            <div className="grid gap-2 border-t pt-4">
              <h3 className="type-eyebrow text-muted-foreground">
                {t("reportBuilder.outlet.title")}
              </h3>
              <OutletScope
                draft={draft}
                onChange={change}
                outlets={outlets}
                state={
                  outletsQuery.isError
                    ? "error"
                    : outletsQuery.data === undefined
                      ? "loading"
                      : "ready"
                }
                onRetry={() => void outletsQuery.refetch()}
              />
            </div>
          </StepCard>
          <StepCard
            step={4}
            title={t("reportBuilder.steps.period.title")}
            hint={t("reportBuilder.steps.period.hint")}
          >
            <PeriodStep draft={draft} onChange={change} today={today} />
          </StepCard>
        </div>

        <div className="grid min-w-0 gap-5">
          <PreviewPanel state={previewState} outletNames={outletNames} />
          {draftHasPersonalData(draft) && (
            <Badge tone="warning" className="w-fit whitespace-normal">
              {t("reportBuilder.personalNotice")}
            </Badge>
          )}
          <SavePanel
            query={validQuery}
            loaded={loaded}
            onSaved={setLoaded}
            offline={!online}
          />
          <SavedReportsPanel loadedId={loaded?.id ?? null} onOpen={open} />
        </div>
      </div>
    </div>
  );
}
