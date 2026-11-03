// Filters of the report viewer: period preset (or custom dates), outlet scope
// and the split. All three live in the URL (see hooks.useReportSearch), the
// same keys a dashboard tile link carries (DASH-02). Splitting by a person-level
// dimension is allowed with the report's permission but is labelled, because its
// export needs an approval (DASH-04).
import { RotateCcw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ReportDefinition,
  ReportPeriodPreset,
} from "@starter/shared/dashboard";
import {
  NO_SPLIT,
  isPersonalDimension,
  namedPresets,
  type ReportSearch,
  type ResolvedPeriod,
} from "../lib";
import { useDimensionLabel, usePresetLabel } from "./labels";

const ALL_OUTLETS = "all";

export function ReportFilters({
  definition,
  period,
  split,
  outletIds,
  availableOutlets,
  onChange,
  onReset,
}: {
  definition: ReportDefinition;
  period: ResolvedPeriod | null;
  split: string | null;
  outletIds: readonly string[];
  availableOutlets: readonly string[];
  onChange: (patch: Partial<Record<keyof ReportSearch, unknown>>) => void;
  onReset: () => void;
}) {
  const t = useT();
  const presetLabel = usePresetLabel();
  const dimensionLabel = useDimensionLabel();
  const presets: ReportPeriodPreset[] = [
    ...namedPresets(definition),
    ...(definition.periodPresets.includes("custom")
      ? (["custom"] as const)
      : []),
  ];
  const preset = period?.preset ?? definition.defaultPeriod;

  function pickPreset(next: string) {
    const value = next as ReportPeriodPreset;
    if (value === "custom") {
      onChange({
        preset: "custom",
        startDate: period?.range.startDate,
        endDate: period?.range.endDate,
      });
      return;
    }
    onChange({ preset: value, startDate: undefined, endDate: undefined });
  }

  function pickDate(key: "startDate" | "endDate", value: string) {
    if (!value || !period) return;
    const range = { ...period.range, [key]: value };
    if (range.startDate > range.endDate) return;
    onChange({ preset: "custom", ...range });
  }

  const outletValue =
    outletIds.length === 1 ? (outletIds[0] ?? ALL_OUTLETS) : ALL_OUTLETS;

  return (
    <CardShell>
      <CardShellBody>
        <form
          aria-label={t("reportViewer.filters.label")}
          className="grid gap-3 p-card sm:grid-cols-2 xl:grid-cols-4"
          onSubmit={(event) => event.preventDefault()}
        >
          <FormField label={t("reportViewer.filters.period")}>
            <Select value={preset} onValueChange={pickPreset}>
              <SelectTrigger aria-label={t("reportViewer.filters.period")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((item) => (
                  <SelectItem key={item} value={item}>
                    {presetLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {preset === "custom" && period && (
            <div className="grid grid-cols-2 gap-3 sm:col-span-2 xl:col-span-2">
              <FormField label={t("reportViewer.filters.from")}>
                <Input
                  type="date"
                  value={period.range.startDate}
                  max={period.range.endDate}
                  onChange={(event) =>
                    pickDate("startDate", event.target.value)
                  }
                />
              </FormField>
              <FormField label={t("reportViewer.filters.to")}>
                <Input
                  type="date"
                  value={period.range.endDate}
                  min={period.range.startDate}
                  onChange={(event) => pickDate("endDate", event.target.value)}
                />
              </FormField>
            </div>
          )}

          {definition.dimensions.length > 0 && (
            <FormField
              label={t("reportViewer.filters.split")}
              hint={
                split !== null && isPersonalDimension(split)
                  ? t("reportViewer.filters.splitPersonalHint")
                  : undefined
              }
            >
              <Select
                value={split ?? NO_SPLIT}
                onValueChange={(next) => onChange({ groupBy: next })}
              >
                <SelectTrigger aria-label={t("reportViewer.filters.split")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SPLIT}>
                    {t("reportViewer.filters.noSplit")}
                  </SelectItem>
                  {definition.dimensions.map((key) => (
                    <SelectItem key={key} value={key}>
                      {dimensionLabel(key)}
                      {isPersonalDimension(key)
                        ? ` · ${t("reportViewer.filters.personalTag")}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}

          {availableOutlets.length > 1 && (
            <FormField label={t("reportViewer.filters.outlet")}>
              <Select
                value={outletValue}
                onValueChange={(next) =>
                  onChange({
                    outletId: next === ALL_OUTLETS ? undefined : [next],
                  })
                }
              >
                <SelectTrigger aria-label={t("reportViewer.filters.outlet")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_OUTLETS}>
                    {t("reportViewer.filters.allOutlets")}
                  </SelectItem>
                  {availableOutlets.map((id, index) => (
                    <SelectItem key={id} value={id}>
                      {t("reportViewer.filters.outletN", { number: index + 1 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}

          <div className="flex items-end">
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw aria-hidden="true" />
              {t("reportViewer.filters.reset")}
            </Button>
          </div>
        </form>
      </CardShellBody>
    </CardShell>
  );
}
