// One metric across the split rows as horizontal bars (dataviz: one series, one
// accent, a value label on every bar, a zero baseline, the table below is the
// text alternative). Hour axes stay chronological; bars never imply a total.
import { useState } from "react";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MetricCellView } from "@/features/ws11-owner-dashboard/components/metric-display";
import type { ReportResult } from "@starter/shared/dashboard";
import { chartData } from "../lib";
import { useDimensionLabel, useDimensionValueLabel } from "./labels";

export function ReportChart({ result }: { result: ReportResult }) {
  const t = useT();
  const dimensionLabel = useDimensionLabel();
  const valueLabel = useDimensionValueLabel();
  const [picked, setPicked] = useState<string | null>(null);
  const metrics = result.definitions;
  const metricCode =
    metrics.find((definition) => definition.code === picked)?.code ??
    metrics[0]?.code ??
    "";
  const definition = metrics.find((item) => item.code === metricCode);
  const data = chartData(result, metricCode);
  const dimension = result.groupBy[0] ?? "";

  return (
    <CardShell>
      <CardShellBody>
        <div className="flex flex-col gap-3 border-b p-card sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="type-title">
              {t("reportViewer.chart.title", {
                metric: definition?.name ?? "",
                dimension: dimensionLabel(dimension),
              })}
            </h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("reportViewer.chart.hint")}
            </p>
          </div>
          {metrics.length > 1 && (
            <SegmentedControl
              label={t("reportViewer.chart.metricLabel")}
              value={metricCode}
              onValueChange={setPicked}
              options={metrics.map((item) => ({
                value: item.code,
                label: item.name,
              }))}
            />
          )}
        </div>
        <ul
          aria-label={t("reportViewer.chart.listLabel", {
            metric: definition?.name ?? "",
          })}
          className="grid gap-2.5 p-card"
        >
          {data.map((datum, index) => (
            <li
              key={`${datum.label}-${index}`}
              // Phone width: label and value on one line, the bar full width
              // below, so the track never collapses to a sliver.
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[minmax(4.5rem,8rem)_minmax(0,1fr)_auto] sm:gap-y-3"
            >
              <span className="truncate">
                {valueLabel(datum.dimension, datum.label)}
              </span>
              <span
                aria-hidden="true"
                className="col-span-2 row-start-2 h-3 rounded-full bg-surface-2 sm:col-span-1 sm:row-start-auto"
              >
                <span
                  className="block h-full rounded-full bg-chart-accent"
                  style={{
                    width: `${Math.max(datum.share * 100, datum.amount > 0 ? 2 : 0)}%`,
                  }}
                />
              </span>
              <span className="min-w-[5.5rem] text-right font-medium">
                <MetricCellView value={datum.value} />
              </span>
            </li>
          ))}
        </ul>
      </CardShellBody>
    </CardShell>
  );
}
