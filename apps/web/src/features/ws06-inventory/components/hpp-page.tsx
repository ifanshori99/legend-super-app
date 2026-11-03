// HPP and food-cost reports (bead legend-5pe; PRD v1.7 §17 "Resep, Produksi &
// HPP"): HPP per menu, actual vs theoretical food cost, menu engineering, and
// recipe completeness. One screen with four in-page views; the period filter
// scopes the two period reports, while HPP per menu and recipe coverage are
// endpoint snapshots. Every figure is read from the report endpoints — the
// screen only formats, counts, and sorts the rows it receives.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api/errors";
import type { BusinessDate } from "@starter/shared/core";
import { useFoodCost, useOnlineStatus, useRecipeCoverage } from "../hpp-hooks";
import {
  coverageCounts,
  defaultPeriod,
  formatBasisPoints,
  HPP_OUTLET_NAME,
  periodLabel,
  type HppPeriod,
} from "../hpp-lib";
import { HppCoverageTab } from "./hpp-coverage-tab";
import { HppEngineeringTab } from "./hpp-engineering-tab";
import { HppFoodCostTab } from "./hpp-food-cost-tab";
import { HppMenuTab } from "./hpp-menu-tab";
import { SignedMoney } from "./hpp-signed-money";

const HPP_VIEWS = [
  { value: "menu", label: "inventoryHpp.tabs.menu" },
  { value: "actual", label: "inventoryHpp.tabs.actual" },
  { value: "engineering", label: "inventoryHpp.tabs.engineering" },
  { value: "coverage", label: "inventoryHpp.tabs.coverage" },
] as const;

type HppView = (typeof HPP_VIEWS)[number]["value"];

export function HppPage() {
  const t = useT();
  const online = useOnlineStatus();
  const [view, setView] = React.useState<HppView>("menu");
  const [period, setPeriod] = React.useState<HppPeriod>(() => defaultPeriod());
  const fromId = React.useId();
  const toId = React.useId();

  const setFromDate = (value: string) => {
    if (value === "") return;
    const fromDate = value as BusinessDate;
    setPeriod((current) => ({
      fromDate,
      toDate: fromDate > current.toDate ? fromDate : current.toDate,
    }));
  };

  const setToDate = (value: string) => {
    if (value === "") return;
    const toDate = value as BusinessDate;
    setPeriod((current) => ({
      fromDate: current.fromDate > toDate ? toDate : current.fromDate,
      toDate,
    }));
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <header className="grid min-w-0 gap-1">
        <h2 className="type-title">{t("inventoryHpp.title")}</h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventoryHpp.subtitle")}
        </p>
      </header>

      {!online && (
        <p
          role="status"
          className="rounded-control bg-warning-subtle px-3 py-2 text-sm leading-5 font-medium text-warning"
        >
          {t("inventoryHpp.offlineNotice")}
        </p>
      )}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        <div className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
          <Field
            label={t("inventoryHpp.controls.fromDate")}
            htmlFor={fromId}
            className="sm:w-40"
          >
            <Input
              id={fromId}
              type="date"
              value={period.fromDate}
              max={period.toDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="h-control-sm w-full"
            />
          </Field>
          <Field
            label={t("inventoryHpp.controls.toDate")}
            htmlFor={toId}
            className="sm:w-40"
          >
            <Input
              id={toId}
              type="date"
              value={period.toDate}
              min={period.fromDate}
              onChange={(event) => setToDate(event.target.value)}
              className="h-control-sm w-full"
            />
          </Field>
          <div className="grid gap-1 sm:w-56">
            <span className="text-xs leading-4 font-medium text-muted-foreground">
              {t("inventoryHpp.controls.outlet")}
            </span>
            {/* The outlet context bead has not landed; one outlet runs the
               back office and its id travels with every report query. */}
            <Badge
              tone="neutral"
              className="h-control-sm w-fit rounded-field px-3 text-sm font-medium"
            >
              {HPP_OUTLET_NAME}
            </Badge>
          </div>
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {t("inventoryHpp.controls.periodHint")}
        </p>
      </div>

      <HppSummary
        period={period}
        onResetPeriod={() => setPeriod(defaultPeriod())}
      />

      <Tabs value={view} onValueChange={(value) => setView(value as HppView)}>
        <TabsList aria-label={t("inventoryHpp.tabsLabel")}>
          {HPP_VIEWS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="px-2.5 sm:px-3.5"
            >
              {t(item.label)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="menu">
          <HppMenuTab />
        </TabsContent>
        <TabsContent value="actual">
          <HppFoodCostTab period={period} />
        </TabsContent>
        <TabsContent value="engineering">
          <HppEngineeringTab period={period} />
        </TabsContent>
        <TabsContent value="coverage">
          <HppCoverageTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HppSummary({
  period,
  onResetPeriod,
}: {
  period: HppPeriod;
  onResetPeriod: () => void;
}) {
  const t = useT();
  const foodCost = useFoodCost(period);
  const coverage = useRecipeCoverage();

  const pending = foodCost.isPending || coverage.isPending;
  const failed = foodCost.isError || coverage.isError;
  const error = foodCost.error ?? coverage.error;
  const offline = error instanceof ApiError && error.code === "NETWORK_ERROR";
  const row = foodCost.data?.data.at(0);
  const coverageRows = coverage.data?.data ?? [];
  const counts = coverageCounts(coverageRows);
  const label = periodLabel(period);

  const retry = () => {
    void foodCost.refetch();
    void coverage.refetch();
  };

  if (pending) {
    return (
      <CardShell>
        <CardShellBody>
          <div aria-busy="true" className="grid gap-2 p-card sm:grid-cols-4">
            <span className="sr-only">{t("inventoryHpp.loading")}</span>
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-24 rounded-container" />
            ))}
          </div>
        </CardShellBody>
      </CardShell>
    );
  }

  if (failed) {
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            title={t("inventoryHpp.errors.load")}
            description={
              offline
                ? t("inventoryHpp.errors.offline")
                : t("inventoryHpp.errors.loadHint")
            }
            onRetry={retry}
          />
        </CardShellBody>
      </CardShell>
    );
  }

  if (!row) {
    return (
      <CardShell>
        <CardShellBody>
          <EmptyState
            title={t("inventoryHpp.stats.emptyTitle")}
            description={t("inventoryHpp.stats.emptyHint")}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onResetPeriod}
              >
                {t("inventoryHpp.stats.resetPeriod")}
              </Button>
            }
          />
        </CardShellBody>
      </CardShell>
    );
  }

  return (
    <StatStrip label={t("inventoryHpp.stats.label")} columns={4}>
      <StatTile
        label={t("inventoryHpp.stats.variance")}
        value={
          <span className="tabular">{formatBasisPoints(row.varianceBp)}</span>
        }
        context={label}
      />
      <StatTile
        label={t("inventoryHpp.stats.varianceIdr")}
        value={<SignedMoney amount={row.varianceIdr} size="stat" />}
        context={label}
      />
      <StatTile
        label={t("inventoryHpp.stats.waste")}
        value={<Money amount={row.wasteIdr} size="stat" />}
        context={label}
      />
      <StatTile
        label={t("inventoryHpp.stats.coverage")}
        value={
          <span className="tabular">
            {t("inventoryHpp.stats.completeCount", {
              complete: counts.complete,
              total: coverageRows.length,
            })}
          </span>
        }
        context={t("inventoryHpp.coverage.count", {
          count: coverageRows.length,
        })}
      />
    </StatStrip>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`grid min-w-0 gap-1 ${className ?? ""}`}>
      <Label
        htmlFor={htmlFor}
        className="text-xs leading-4 font-medium text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}
