// One definition of how a metric value is printed, so a tile and a table cell
// never format the same registry row two ways (DASH-01). Money uses <Money>,
// counts use <NumberDisplay>, and every figure keeps tabular figures.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Money, NumberDisplay } from "@/components/ui/money";
import type { MetricValue } from "@starter/shared/metrics";
import { durationParts, formatDecimal, formatPercent } from "../board";

export function PercentText({ value }: { value: string }) {
  return <span className="tabular">{formatPercent(value)}%</span>;
}

/** Seconds as "7 mnt 32 dtk" (catalog units, never a raw number). */
export function DurationText({ seconds }: { seconds: number }) {
  const t = useT();
  const parts = durationParts(seconds);
  const label =
    parts.minutes > 0 && parts.seconds > 0
      ? t("ownerDashboard.duration.minutesSeconds", {
          minutes: parts.minutes,
          seconds: parts.seconds,
        })
      : parts.minutes > 0
        ? t("ownerDashboard.duration.minutes", { minutes: parts.minutes })
        : t("ownerDashboard.duration.seconds", { seconds: parts.seconds });
  return <span className="tabular">{label}</span>;
}

/**
 * A decimal with its unit suffix, rounded for display only: "1,84×",
 * "74,5 mnt", "42,7 GB". Minutes use the catalog so the unit is translated.
 */
export function DecimalText({
  value,
  suffix,
}: {
  value: string;
  /** "×", "GB", or "mnt" (minutes, translated). */
  suffix?: string;
}) {
  const t = useT();
  const text = formatDecimal(value);
  if (suffix === "mnt")
    return (
      <span className="tabular">
        {t("ownerDashboard.duration.minutesValue", { value: text })}
      </span>
    );
  return (
    <span className="tabular">{suffix ? `${text} ${suffix}` : text}</span>
  );
}

/** A value in a StatTile: the tile owns the type step, so values inherit it. */
export function MetricValueView({ value }: { value: MetricValue }) {
  switch (value.unit) {
    case "idr":
      return <Money amount={value.valueIdr} className="text-[length:inherit]" />;
    case "count":
      return (
        <NumberDisplay value={value.value} className="text-[length:inherit]" />
      );
    case "percent":
      return <PercentText value={value.value} />;
    case "decimal":
      return <DecimalText value={value.value} />;
    case "seconds":
      return <DurationText seconds={value.value} />;
  }
}

/** A value in a table cell, with the unit suffix that carries its meaning. */
export function MetricCellView({
  value,
  suffix,
}: {
  value: MetricValue | null;
  suffix?: string;
}): ReactNode {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  switch (value.unit) {
    case "idr":
      return <Money amount={value.valueIdr} size="sm" />;
    case "count":
      return <NumberDisplay value={value.value} size="sm" />;
    case "percent":
      return <PercentText value={value.value} />;
    case "decimal":
      return <DecimalText value={value.value} suffix={suffix} />;
    case "seconds":
      return <DurationText seconds={value.value} />;
  }
}
