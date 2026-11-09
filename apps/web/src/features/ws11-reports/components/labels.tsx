// Catalog text for the keys a report definition carries: dimension names,
// dimension values, families and export formats. Unknown keys fall back to the
// raw key, so a dimension a later family adds still renders (never blank).
import { useT } from "@/components/i18n";
import { channelMessageKey } from "@/features/ws11-owner-dashboard/board";
import { hourLabel } from "../lib";

const DIMENSION_KEYS = {
  outlet: "reportViewer.dimensions.outlet",
  hour: "reportViewer.dimensions.hour",
  day_of_week: "reportViewer.dimensions.day_of_week",
  channel: "reportViewer.dimensions.channel",
  payment_method: "reportViewer.dimensions.payment_method",
  menu_item: "reportViewer.dimensions.menu_item",
  menu_category: "reportViewer.dimensions.menu_category",
  zone: "reportViewer.dimensions.zone",
  employee: "reportViewer.dimensions.employee",
  station: "reportViewer.dimensions.station",
  customer_tier: "reportViewer.dimensions.customer_tier",
  supplier: "reportViewer.dimensions.supplier",
  facility: "reportViewer.dimensions.facility",
  unit: "reportViewer.dimensions.unit",
  product: "reportViewer.dimensions.product",
  promo: "reportViewer.dimensions.promo",
} as const;

const PAYMENT_KEYS = {
  cash: "reportViewer.values.payment.cash",
  qris: "reportViewer.values.payment.qris",
  debit: "reportViewer.values.payment.debit",
  credit: "reportViewer.values.payment.credit",
  ewallet: "reportViewer.values.payment.ewallet",
} as const;

export function useDimensionLabel(): (key: string) => string {
  const t = useT();
  return (key) =>
    key in DIMENSION_KEYS
      ? t(DIMENSION_KEYS[key as keyof typeof DIMENSION_KEYS])
      : key;
}

export function useDimensionValueLabel(): (
  key: string,
  value: string,
) => string {
  const t = useT();
  return (key, value) => {
    if (key === "channel") {
      const messageKey = channelMessageKey(value);
      return messageKey === null ? value : t(messageKey);
    }
    if (key === "payment_method" && value in PAYMENT_KEYS)
      return t(PAYMENT_KEYS[value as keyof typeof PAYMENT_KEYS]);
    if (key === "hour") return hourLabel(value) ?? value;
    return value;
  };
}

const FORMAT_KEYS = {
  csv: "reportViewer.export.formats.csv",
  xlsx: "reportViewer.export.formats.xlsx",
  pdf: "reportViewer.export.formats.pdf",
} as const;

export function useFormatLabel(): (format: "csv" | "xlsx" | "pdf") => string {
  const t = useT();
  return (format) => t(FORMAT_KEYS[format]);
}

const PRESET_KEYS = {
  today: "reportViewer.presets.today",
  yesterday: "reportViewer.presets.yesterday",
  this_week: "reportViewer.presets.this_week",
  last_week: "reportViewer.presets.last_week",
  this_month: "reportViewer.presets.this_month",
  last_month: "reportViewer.presets.last_month",
  this_quarter: "reportViewer.presets.this_quarter",
  last_quarter: "reportViewer.presets.last_quarter",
  this_year: "reportViewer.presets.this_year",
  year_to_date: "reportViewer.presets.year_to_date",
  custom: "reportViewer.presets.custom",
} as const;

export function usePresetLabel(): (preset: keyof typeof PRESET_KEYS) => string {
  const t = useT();
  return (preset) => t(PRESET_KEYS[preset]);
}
