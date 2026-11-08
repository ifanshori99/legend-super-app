// The four configuration steps of the builder (PRD v1.7 §3 F36): metrics,
// split by, filters and period, plus the outlet scope. Each only offers what
// the contract accepts (builder.ts), so an invalid combination is prevented
// here and the API stays the second line of defence.
import { useMemo, useState } from "react";
import { cn } from "cn";
import { Plus, Search, Trash2, UserRound } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PERSONAL_DATA_DIMENSIONS,
  reportMetricByCode,
} from "@starter/shared/dashboard";
import type { MetricDefinition } from "@starter/shared/metrics";
import type { Outlet } from "@starter/shared/platform";
import {
  PERIOD_PRESETS,
  REPORT_BUILDER_MAX_DIMENSIONS,
  REPORT_BUILDER_MAX_FILTERS,
  REPORT_BUILDER_MAX_METRICS,
  applyPreset,
  filterableDimensions,
  sharedDimensions,
  type BuilderDraft,
  type PeriodPreset,
} from "../builder";
import { dimensionLabel } from "../format";

type DraftProps = {
  draft: BuilderDraft;
  onChange: (next: BuilderDraft) => void;
};

// ---- Step 1: metrics -------------------------------------------------------

export function MetricStep({
  draft,
  metrics,
  onToggle,
}: {
  draft: BuilderDraft;
  /** Only the metrics the caller may use (usableMetrics). */
  metrics: readonly MetricDefinition[];
  onToggle: (code: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle === ""
      ? metrics
      : metrics.filter(
          (metric) =>
            metric.name.toLowerCase().includes(needle) ||
            metric.code.includes(needle),
        );
  }, [metrics, search]);
  const full = draft.metricCodes.length >= REPORT_BUILDER_MAX_METRICS;

  if (metrics.length === 0)
    return (
      <EmptyState
        className="py-6"
        title={t("reportBuilder.metric.noneAvailableTitle")}
        description={t("reportBuilder.metric.noneAvailableHint")}
      />
    );

  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t("reportBuilder.metric.searchLabel")}
          placeholder={t("reportBuilder.metric.searchPlaceholder")}
          className="ps-9"
        />
      </div>
      <p className="text-sm leading-5 text-muted-foreground" aria-live="polite">
        {t("reportBuilder.metric.selectedCount", {
          count: draft.metricCodes.length,
          max: REPORT_BUILDER_MAX_METRICS,
        })}
      </p>
      {visible.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {t("reportBuilder.metric.noMatch")}
        </p>
      ) : (
        <ul
          aria-label={t("reportBuilder.steps.metric.title")}
          className="max-h-72 divide-y overflow-y-auto rounded-control border-(length:--border-w)"
        >
          {visible.map((metric) => {
            const checked = draft.metricCodes.includes(metric.code);
            const disabled = !checked && full;
            const id = `metric-${metric.code}`;
            return (
              <li key={metric.code}>
                <div
                  className={cn(
                    "flex min-h-control items-center gap-3 px-3 py-2",
                    disabled && "opacity-60",
                  )}
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={() => onToggle(metric.code)}
                  />
                  <Label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center justify-between gap-x-2"
                  >
                    <span className="min-w-0">{metric.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t(`reportBuilder.metric.units.${metric.unit}`)}
                    </span>
                  </Label>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {full && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("reportBuilder.metric.limitReached", {
            max: REPORT_BUILDER_MAX_METRICS,
          })}
        </p>
      )}
    </div>
  );
}

// ---- Step 2: split by ------------------------------------------------------

export function DimensionStep({
  draft,
  metrics,
  hidePersonal = false,
  onChange,
}: DraftProps & {
  metrics: readonly MetricDefinition[];
  /** SH-01: aggregate-only callers are not offered person splits. */
  hidePersonal?: boolean;
}) {
  const t = useT();
  const shared = sharedDimensions(draft.metricCodes, hidePersonal);
  // Every dimension some selected metric offers; the ones not all share are
  // shown disabled with the reason instead of silently missing.
  const offered = useMemo(() => {
    const keys = new Set<string>();
    for (const metric of metrics)
      if (draft.metricCodes.includes(metric.code))
        for (const key of metric.dimensions)
          if (!(hidePersonal && PERSONAL_DATA_DIMENSIONS.includes(key)))
            keys.add(key);
    return [...keys];
  }, [metrics, draft.metricCodes, hidePersonal]);

  if (draft.metricCodes.length === 0)
    return (
      <p className="text-sm leading-5 text-muted-foreground">
        {t("reportBuilder.dimension.pickMetricFirst")}
      </p>
    );

  const toggle = (key: string) =>
    onChange({
      ...draft,
      groupBy: draft.groupBy.includes(key)
        ? draft.groupBy.filter((item) => item !== key)
        : [...draft.groupBy, key],
    });
  const full = draft.groupBy.length >= REPORT_BUILDER_MAX_DIMENSIONS;

  return (
    <div className="grid gap-3">
      <ul className="grid gap-1">
        {offered.map((key) => {
          const checked = draft.groupBy.includes(key);
          const isShared = shared.includes(key);
          const disabled = !isShared || (!checked && full);
          const id = `dimension-${key}`;
          return (
            <li
              key={key}
              className={cn(
                "flex min-h-control items-start gap-3 rounded-control px-1 py-1.5",
                disabled && "opacity-60",
              )}
            >
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={checked}
                disabled={disabled}
                onCheckedChange={() => toggle(key)}
              />
              <Label
                htmlFor={id}
                className="grid min-w-0 cursor-pointer gap-0.5"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {dimensionLabel(t, key)}
                  {PERSONAL_DATA_DIMENSIONS.includes(key) && (
                    <Badge tone="warning">
                      <UserRound aria-hidden="true" />
                      {t("reportBuilder.dimension.personal")}
                    </Badge>
                  )}
                </span>
                {!isShared && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("reportBuilder.dimension.notShared")}
                  </span>
                )}
              </Label>
            </li>
          );
        })}
      </ul>
      {full && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("reportBuilder.dimension.limitReached", {
            max: REPORT_BUILDER_MAX_DIMENSIONS,
          })}
        </p>
      )}
    </div>
  );
}

// ---- Step 3: filters -------------------------------------------------------

export function FilterStep({
  draft,
  hidePersonal = false,
  onChange,
}: DraftProps & { hidePersonal?: boolean }) {
  const t = useT();
  const keys = filterableDimensions(draft.metricCodes, hidePersonal);
  const unused = keys.filter(
    (key) => !draft.filters.some((filter) => filter.key === key),
  );

  if (draft.metricCodes.length === 0)
    return (
      <p className="text-sm leading-5 text-muted-foreground">
        {t("reportBuilder.dimension.pickMetricFirst")}
      </p>
    );

  const setFilter = (
    index: number,
    patch: Partial<{ key: string; valuesText: string }>,
  ) =>
    onChange({
      ...draft,
      filters: draft.filters.map((filter, position) =>
        position === index ? { ...filter, ...patch } : filter,
      ),
    });
  const canAdd =
    unused.length > 0 && draft.filters.length < REPORT_BUILDER_MAX_FILTERS;

  return (
    <div className="grid gap-3">
      {draft.filters.length === 0 && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("reportBuilder.filter.none")}
        </p>
      )}
      {draft.filters.map((filter, index) => (
        <div
          key={filter.key}
          className="grid gap-3 rounded-control border-(length:--border-w) p-3"
        >
          <div className="flex items-end gap-2">
            <FormField
              label={t("reportBuilder.filter.keyLabel")}
              required
              className="min-w-0 flex-1"
            >
              <Select
                value={filter.key}
                onValueChange={(key) => setFilter(index, { key })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[filter.key, ...unused].map((key) => (
                    <SelectItem key={key} value={key}>
                      {dimensionLabel(t, key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("reportBuilder.filter.remove", {
                name: dimensionLabel(t, filter.key),
              })}
              onClick={() =>
                onChange({
                  ...draft,
                  filters: draft.filters.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          <FormField
            label={t("reportBuilder.filter.valuesLabel")}
            hint={t("reportBuilder.filter.valuesHint")}
            required
          >
            <Input
              value={filter.valuesText}
              onChange={(event) =>
                setFilter(index, { valuesText: event.target.value })
              }
              placeholder={t("reportBuilder.filter.valuesPlaceholder")}
            />
          </FormField>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={!canAdd}
        onClick={() =>
          unused[0] !== undefined &&
          onChange({
            ...draft,
            filters: [...draft.filters, { key: unused[0], valuesText: "" }],
          })
        }
      >
        <Plus aria-hidden="true" />
        {t("reportBuilder.filter.add")}
      </Button>
    </div>
  );
}

// ---- Outlet scope ----------------------------------------------------------

export function OutletScope({
  draft,
  onChange,
  outlets,
  state,
  onRetry,
}: DraftProps & {
  outlets: readonly Outlet[];
  state: "loading" | "error" | "ready";
  onRetry: () => void;
}) {
  const t = useT();
  if (state === "loading") return <Skeleton className="h-16 w-full" />;
  if (state === "error")
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t("reportBuilder.outlet.loadFailed")}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  // One outlet in scope: nothing to choose, the server scopes it anyway.
  if (outlets.length <= 1)
    return (
      <p className="text-sm leading-5 text-muted-foreground">
        {outlets[0]?.name ?? t("reportBuilder.outlet.all")}
      </p>
    );
  const allSelected = draft.outletIds.length === 0;
  return (
    <fieldset className="grid gap-1">
      <legend className="sr-only">{t("reportBuilder.outlet.title")}</legend>
      <div className="flex min-h-control items-center gap-3 px-1">
        <Checkbox
          id="outlet-all"
          checked={allSelected}
          onCheckedChange={() => onChange({ ...draft, outletIds: [] })}
        />
        <Label htmlFor="outlet-all" className="cursor-pointer">
          {t("reportBuilder.outlet.all")}
        </Label>
      </div>
      {outlets.map((outlet) => {
        const checked = draft.outletIds.includes(outlet.id);
        return (
          <div
            key={outlet.id}
            className="flex min-h-control items-center gap-3 px-1"
          >
            <Checkbox
              id={`outlet-${outlet.id}`}
              checked={checked}
              onCheckedChange={() =>
                onChange({
                  ...draft,
                  outletIds: checked
                    ? draft.outletIds.filter((id) => id !== outlet.id)
                    : [...draft.outletIds, outlet.id],
                })
              }
            />
            <Label htmlFor={`outlet-${outlet.id}`} className="cursor-pointer">
              {outlet.name}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

// ---- Step 4: period and sort -----------------------------------------------

export function PeriodStep({
  draft,
  onChange,
  today,
}: DraftProps & { today: string }) {
  const t = useT();
  const custom = draft.preset === "custom";
  const rangeInvalid = draft.startDate > draft.endDate;
  const sortOptions = [...draft.metricCodes, ...draft.groupBy];

  return (
    <div className="grid gap-4">
      <FormField label={t("reportBuilder.period.presetLabel")} required>
        <Select
          value={draft.preset}
          onValueChange={(preset) =>
            onChange(applyPreset(draft, preset as PeriodPreset, today))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_PRESETS.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {t(`reportBuilder.period.presets.${preset}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t("reportBuilder.period.startDate")} required>
          <Input
            type="date"
            value={draft.startDate}
            max={draft.endDate}
            onChange={(event) =>
              onChange({
                ...draft,
                preset: "custom",
                startDate: event.target.value,
              })
            }
          />
        </FormField>
        <FormField
          label={t("reportBuilder.period.endDate")}
          required
          error={
            custom && rangeInvalid
              ? t("reportBuilder.issues.draft.periodRange")
              : undefined
          }
        >
          <Input
            type="date"
            value={draft.endDate}
            min={draft.startDate}
            onChange={(event) =>
              onChange({
                ...draft,
                preset: "custom",
                endDate: event.target.value,
              })
            }
          />
        </FormField>
      </div>
      {sortOptions.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t("reportBuilder.sort.label")}>
            <Select
              value={draft.sortColumn ?? "__none"}
              onValueChange={(value) =>
                onChange({
                  ...draft,
                  sortColumn: value === "__none" ? null : value,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">
                  {t("reportBuilder.sort.none")}
                </SelectItem>
                {sortOptions.map((column) => (
                  <SelectItem key={column} value={column}>
                    {draft.groupBy.includes(column)
                      ? dimensionLabel(t, column)
                      : (reportMetricByCode.get(column)?.name ?? column)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("reportBuilder.sort.directionLabel")}>
            <Select
              value={draft.sortDirection}
              disabled={draft.sortColumn === null}
              onValueChange={(value) =>
                onChange({
                  ...draft,
                  sortDirection: value as "asc" | "desc",
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">
                  {t("reportBuilder.sort.desc")}
                </SelectItem>
                <SelectItem value="asc">
                  {t("reportBuilder.sort.asc")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </div>
      )}
    </div>
  );
}
