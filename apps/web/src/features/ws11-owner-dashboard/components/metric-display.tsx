// One definition of how a metric value is printed, so a tile and a table cell
// never format the same registry row two ways (DASH-01). DESIGN.md v3: stat
// values use the money-display tier with a scaled unit suffix; table cells stay
// on the table-data size, right-aligned and tabular.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Money, NumberDisplay } from "@/components/ui/money";
import type { MetricValue } from "@starter/shared/metrics";
import { durationParts, formatDecimal, formatPercent } from "../board";

/** The scaled suffix Metoric gives a stat value ("%" at 0.6em, raised). */
function ScaledSuffix({ children }: { children: ReactNode }) {
  return (
    <span className="ms-0.5 align-[0.32em] text-[0.6em] font-medium tracking-normal text-muted-foreground">
      {children}
    </span>
  );
}

/** Seconds as "7 mnt 32 dtk" in a table (catalog units, not a raw number). */
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

/** A decimal with its unit suffix in a table: "1,84×", "74,5 mnt", "42,7 GB". */
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
  return <span className="tabular">{suffix ? `${text} ${suffix}` : text}</span>;
}

/**
 * A value in a StatTile: the money-display tier with a scaled unit suffix, the
 * same figure treatment the management KPI strip uses.
 */
export function StatMetricValue({
  value,
  suffix,
}: {
  value: MetricValue;
  /** Unit suffix for decimal values, e.g. "×" or "GB". */
  suffix?: string;
}) {
  const t = useT();
  switch (value.unit) {
    case "idr":
      return <Money amount={value.valueIdr} size="stat" />;
    case "count":
      return <NumberDisplay value={value.value} size="stat" />;
    case "percent":
      return (
        <span className="type-money-display">
          {formatPercent(value.value)}
          <ScaledSuffix>%</ScaledSuffix>
        </span>
      );
    case "decimal":
      return (
        <span className="type-money-display">
          {formatDecimal(value.value)}
          {suffix ? <ScaledSuffix>{suffix}</ScaledSuffix> : null}
        </span>
      );
    case "seconds":
      return (
        <span className="type-money-display">
          {Math.round(value.value / 60)}
          <ScaledSuffix>
            {t("ownerDashboard.duration.unitMinutes")}
          </ScaledSuffix>
        </span>
      );
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
      return <span className="tabular">{formatPercent(value.value)}%</span>;
    case "decimal":
      return <DecimalText value={value.value} suffix={suffix} />;
    case "seconds":
      return <DurationText seconds={value.value} />;
  }
}
