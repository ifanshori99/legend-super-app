// Display formatting for the report builder: numbers, dates, durations and the
// catalog labels of dimensions, split values and contract errors. Pure and
// framework free, so the builder table and the chart print a figure one way.
import {
  formatNumber,
  formatRupiah,
  isMessageKey,
  type MessageKey,
  type Translate,
} from "@starter/shared/i18n";
import type { MetricValue } from "@starter/shared/metrics";
import { reportErrorCodeOf, isOfflineError } from "./builder.ts";

const dateFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const dateTimeFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const decimalFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatBusinessDate(date: string): string {
  return dateFormat.format(new Date(`${date}T00:00:00.000Z`));
}

export function formatPeriod(period: {
  startDate: string;
  endDate: string;
}): string {
  return period.startDate === period.endDate
    ? formatBusinessDate(period.startDate)
    : `${formatBusinessDate(period.startDate)} – ${formatBusinessDate(period.endDate)}`;
}

export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

/** The number a metric value stands for (chart bar length, sorting). */
export function metricNumber(value: MetricValue): number {
  return value.unit === "idr" ? value.valueIdr : Number(value.value);
}

/** A metric value as text, with the unit that carries its meaning. */
export function formatMetricValue(value: MetricValue, t: Translate): string {
  switch (value.unit) {
    case "idr":
      return formatRupiah(value.valueIdr);
    case "count":
      return formatNumber(value.value);
    case "percent":
      return `${decimalFormat.format(Number(value.value))}%`;
    case "decimal":
      return decimalFormat.format(Number(value.value));
    case "seconds": {
      const minutes = Math.floor(value.value / 60);
      const seconds = value.value % 60;
      if (minutes === 0)
        return t("reportBuilder.duration.seconds", { seconds });
      return seconds === 0
        ? t("reportBuilder.duration.minutes", { minutes })
        : t("reportBuilder.duration.minutesSeconds", { minutes, seconds });
    }
  }
}

function labelOrKey(t: Translate, key: string, fallback: string): string {
  return isMessageKey(key) ? t(key as MessageKey) : fallback;
}

/** "channel" -> "Kanal"; an unknown key stays readable instead of blank. */
export function dimensionLabel(t: Translate, key: string): string {
  return labelOrKey(
    t,
    `reportBuilder.dimensions.${key}`,
    key.replaceAll("_", " "),
  );
}

/** One split value as people read it ("08" -> "08.00", "1" -> "Senin"). */
export function dimensionValueLabel(
  t: Translate,
  key: string,
  value: string,
  outletNames?: ReadonlyMap<string, string>,
): string {
  switch (key) {
    case "outlet":
      return outletNames?.get(value) ?? value;
    case "hour":
      return `${value.padStart(2, "0")}.00`;
    case "day_of_week":
      return labelOrKey(t, `reportBuilder.weekdays.${value}`, value);
    case "channel":
    case "payment_method":
      return labelOrKey(t, `reportBuilder.values.${key}.${value}`, value);
    default:
      return value;
  }
}

/** Catalog text for a contract error code (stable key, never the API text). */
export function reportErrorText(t: Translate, error: unknown): string {
  if (isOfflineError(error)) return t("reportBuilder.errors.offline");
  const code = reportErrorCodeOf(error);
  return code === null
    ? t("reportBuilder.errors.generic")
    : t(`reportBuilder.errors.${code}`);
}
