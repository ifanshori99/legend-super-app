// Serving-time analytics (PRD §3 F12 "Analitik Serving Time"): median,
// average and target verdict per station, hour, employee or item for a
// business-date period. One table plus a comparable bar per group; text and
// markers carry the meaning, not color alone.
import * as React from "react";
import { formatNumber, type Translate } from "@starter/shared/i18n";
import type { ServingTimeSummary } from "@starter/shared/kitchen";
import { businessDateSchema } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useServingTimeSummary } from "../hooks.ts";
import { durationParts, recentBusinessPeriod } from "../lib.ts";
import { KITCHEN_TIME_ZONE } from "../outlet.ts";

const GROUPS = ["station", "hour", "employee", "item"] as const;
type Group = (typeof GROUPS)[number];

/** Last seven outlet days including today: covers the fixture service day. */
function defaultPeriod(): { startDate: string; endDate: string } {
  return recentBusinessPeriod(new Date(), KITCHEN_TIME_ZONE);
}

function durationText(t: Translate, seconds: number): string {
  const parts = durationParts(seconds);
  if (parts.minutes === 0)
    return t("kitchenConfig.serving.durationSeconds", {
      seconds: parts.seconds,
    });
  if (parts.seconds === 0)
    return t("kitchenConfig.serving.durationMinutes", {
      minutes: parts.minutes,
    });
  return t("kitchenConfig.serving.duration", {
    minutes: parts.minutes,
    seconds: parts.seconds,
  });
}

function ServingBar({
  row,
  scaleSeconds,
}: {
  row: ServingTimeSummary;
  /** Longest median/target in the table, so bars are comparable across rows. */
  scaleSeconds: number;
}) {
  const t = useT();
  const target = row.targetSeconds;
  const maximum = Math.max(scaleSeconds, 1);
  const width = Math.max(2, Math.round((row.medianSeconds / maximum) * 100));
  const targetLeft =
    target === null ? null : Math.round((target / maximum) * 100);
  return (
    <li className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="min-w-0 font-medium">{row.label}</span>
        <span className="text-muted-foreground tabular">
          {durationText(t, row.medianSeconds)}
          {" · "}
          {target === null
            ? t("kitchenConfig.serving.noTarget")
            : t("kitchenConfig.serving.columns.target") +
              " " +
              durationText(t, target)}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-muted" aria-hidden="true">
        <div
          className="h-full rounded-full bg-brand/70"
          style={{ width: `${width}%` }}
        />
        {targetLeft !== null && (
          <span
            className="absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-background ring-1 ring-foreground"
            style={{ left: `${Math.min(99, targetLeft)}%` }}
          />
        )}
      </div>
    </li>
  );
}

export function ServingTimePage() {
  const t = useT();
  const [group, setGroup] = React.useState<Group>("station");
  const [period, setPeriod] = React.useState(defaultPeriod);

  const valid =
    period.startDate !== "" &&
    period.endDate !== "" &&
    period.startDate <= period.endDate;
  const fallback = defaultPeriod();
  const query = {
    group,
    startDate: businessDateSchema.parse(
      valid ? period.startDate : fallback.startDate,
    ),
    endDate: businessDateSchema.parse(
      valid ? period.endDate : fallback.endDate,
    ),
  };
  const summary = useServingTimeSummary(query, valid);
  const rows = summary.data ?? [];
  const scaleSeconds = rows.reduce(
    (longest, row) =>
      Math.max(longest, row.medianSeconds, row.targetSeconds ?? 0),
    1,
  );

  return (
    <div className="grid min-w-0 gap-5">
      <Card
        aria-label={t("kitchenConfig.serving.period")}
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t("kitchenConfig.serving.startDate")}
            error={
              !valid ? t("kitchenConfig.serving.invalidPeriod") : undefined
            }
            required
          >
            <Input
              type="date"
              value={period.startDate}
              max={period.endDate || undefined}
              onChange={(event) =>
                setPeriod((current) => ({
                  ...current,
                  startDate: event.target.value,
                }))
              }
            />
          </FormField>
          <FormField label={t("kitchenConfig.serving.endDate")} required>
            <Input
              type="date"
              value={period.endDate}
              min={period.startDate || undefined}
              onChange={(event) =>
                setPeriod((current) => ({
                  ...current,
                  endDate: event.target.value,
                }))
              }
            />
          </FormField>
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold">
            {t("kitchenConfig.serving.group")}
          </span>
          <SegmentedControl
            value={group}
            onValueChange={setGroup}
            label={t("kitchenConfig.serving.group")}
            options={GROUPS.map((value) => ({
              value,
              label: t(`kitchenConfig.serving.groups.${value}`),
            }))}
          />
        </div>
      </Card>

      {summary.isError && !summary.data ? (
        <ErrorState
          title={t("kitchenConfig.serving.errorTitle")}
          description={t("kitchenConfig.serving.errorHint")}
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <DataTableShell
          title={t("kitchenConfig.serving.title")}
          description={t("kitchenConfig.serving.description")}
          state={
            !valid
              ? "empty"
              : summary.isPending
                ? "loading"
                : rows.length === 0
                  ? "empty"
                  : "ready"
          }
          onRetry={() => void summary.refetch()}
          empty={
            valid
              ? {
                  title: t("kitchenConfig.serving.emptyTitle"),
                  description: t("kitchenConfig.serving.emptyHint"),
                }
              : {
                  title: t("kitchenConfig.serving.invalidPeriod"),
                  description: t("kitchenConfig.serving.emptyHint"),
                }
          }
          rowCount={rows.length}
          loadingRows={6}
        >
          <div className="grid gap-5 p-card">
            <section
              aria-labelledby="serving-chart-title"
              className="grid gap-3"
            >
              <div className="grid gap-0.5">
                <h3 id="serving-chart-title" className="text-sm font-semibold">
                  {t("kitchenConfig.serving.chartTitle")}
                </h3>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("kitchenConfig.serving.chartHint")}
                </p>
              </div>
              <ul className="grid gap-3">
                {rows.map((row) => (
                  <ServingBar
                    key={row.groupKey}
                    row={row}
                    scaleSeconds={scaleSeconds}
                  />
                ))}
              </ul>
            </section>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("kitchenConfig.serving.columns.group")}
                  </TableHead>
                  <TableHead numeric>
                    {t("kitchenConfig.serving.columns.samples")}
                  </TableHead>
                  <TableHead numeric>
                    {t("kitchenConfig.serving.columns.median")}
                  </TableHead>
                  <TableHead numeric className="hidden sm:table-cell">
                    {t("kitchenConfig.serving.columns.average")}
                  </TableHead>
                  <TableHead numeric className="hidden md:table-cell">
                    {t("kitchenConfig.serving.columns.target")}
                  </TableHead>
                  <TableHead numeric>
                    {t("kitchenConfig.serving.columns.within")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.groupKey}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell numeric>
                      {formatNumber(row.sampleCount)}
                    </TableCell>
                    <TableCell numeric>
                      {durationText(t, row.medianSeconds)}
                    </TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      {durationText(t, row.averageSeconds)}
                    </TableCell>
                    <TableCell numeric className="hidden md:table-cell">
                      {row.targetSeconds === null
                        ? t("kitchenConfig.serving.noTarget")
                        : durationText(t, row.targetSeconds)}
                    </TableCell>
                    <TableCell numeric>
                      {t("kitchenConfig.serving.withinValue", {
                        percent: formatNumber(row.withinTargetBp / 100),
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DataTableShell>
      )}
    </div>
  );
}
