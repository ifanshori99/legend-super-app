// "/owner" — the owner dashboard, part 1 (PRD v1.7 §3 F34; bead legend-k8fk).
// The shell (ManagementShell, Padat density, dashboard.owner.view + MFA) comes
// from the area layout and its topbar owns the page title (DESIGN.md v3); this
// file owns the toolbar and the four part-1 sections.
import { CalendarDays, RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBusinessDate, formatOutletTime } from "../board";
import { OwnerBoardProvider, useOwnerBoardContext } from "../board-context";
import { useOwnerBoard, useOwnerDashboard } from "../hooks";
import { AlertsSection } from "./alerts-section";
import { CostMarginSection } from "./cost-margin-section";
import { DailySummarySection } from "./daily-summary-section";
import { FinanceSection } from "./finance-section";
import { MultiOutletSection } from "./multi-outlet-section";
import { ServiceQualitySection } from "./service-quality-section";
import { OperationsSection } from "./operations-section";
import { RealtimeSummarySection } from "./realtime-section";
import { SeatsSection } from "./seats-section";
import { ShowerSection } from "./shower-section";

function BoardToolbar() {
  const t = useT();
  const board = useOwnerBoardContext();
  const { layout } = board;
  const isEstimate = layout.monitoringPeriod.status !== "closed";
  const meta = [
    t("ownerDashboard.businessDate", {
      date: formatBusinessDate(layout.businessDate),
    }),
    t("ownerDashboard.updatedAt", {
      time: formatOutletTime(layout.generatedAt),
    }),
  ].join(" · ");

  return (
    <div className="grid gap-3">
      <TabsList aria-label={t("ownerDashboard.tabsLabel")}>
        <TabsTrigger value="realtime_summary" className="px-2.5 sm:px-3.5">
          {t("ownerDashboard.tabs.realtime")}
        </TabsTrigger>
        <TabsTrigger value="operations" className="px-2.5 sm:px-3.5">
          {t("ownerDashboard.tabs.operations")}
        </TabsTrigger>
        <TabsTrigger value="shower" className="px-2.5 sm:px-3.5">
          {t("ownerDashboard.tabs.shower")}
        </TabsTrigger>
        <TabsTrigger
          value="seats_wfc"
          aria-label={t("ownerDashboard.tabs.seatsAria")}
          className="px-2.5 sm:px-3.5"
        >
          {t("ownerDashboard.tabs.seats")}
        </TabsTrigger>
        <TabsTrigger value="cost_margin" className="px-2.5 sm:px-3.5">
          {t("ownerInsights.tabs.cost")}
        </TabsTrigger>
        <TabsTrigger value="service_quality" className="px-2.5 sm:px-3.5">
          {t("ownerInsights.tabs.service")}
        </TabsTrigger>
        <TabsTrigger value="finance" className="px-2.5 sm:px-3.5">
          {t("ownerInsights.tabs.finance")}
        </TabsTrigger>
        <TabsTrigger value="alerts" className="px-2.5 sm:px-3.5">
          {t("ownerInsights.tabs.alerts")}
        </TabsTrigger>
        <TabsTrigger value="daily_summary" className="px-2.5 sm:px-3.5">
          {t("ownerInsights.tabs.daily")}
        </TabsTrigger>
        <TabsTrigger value="multi_outlet" className="px-2.5 sm:px-3.5">
          {t("ownerInsights.tabs.multi")}
        </TabsTrigger>
      </TabsList>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {isEstimate && (
            <Badge tone="info">{t("ownerDashboard.estimate")}</Badge>
          )}
          <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground tabular">
            <CalendarDays
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0">{meta}</span>
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={board.isFetching}
          onClick={board.refresh}
          className="self-end sm:self-auto"
        >
          <RotateCw aria-hidden="true" />
          {t("ownerDashboard.refresh")}
        </Button>
      </div>

      {isEstimate && (
        <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
          {t("ownerDashboard.estimateHint")}
        </p>
      )}
    </div>
  );
}

export function OwnerDashboardPage() {
  const { data: layout } = useOwnerDashboard();
  const board = useOwnerBoard(layout);

  return (
    <OwnerBoardProvider board={board}>
      <Tabs
        defaultValue="realtime_summary"
        className="grid grid-cols-[minmax(0,1fr)] gap-5"
      >
        <BoardToolbar />
        <TabsContent value="realtime_summary" className="pt-0">
          <RealtimeSummarySection />
        </TabsContent>
        <TabsContent value="operations" className="pt-0">
          <OperationsSection />
        </TabsContent>
        <TabsContent value="shower" className="pt-0">
          <ShowerSection />
        </TabsContent>
        <TabsContent value="seats_wfc" className="pt-0">
          <SeatsSection />
        </TabsContent>
        <TabsContent value="cost_margin" className="pt-0">
          <CostMarginSection />
        </TabsContent>
        <TabsContent value="service_quality" className="pt-0">
          <ServiceQualitySection />
        </TabsContent>
        <TabsContent value="finance" className="pt-0">
          <FinanceSection />
        </TabsContent>
        <TabsContent value="alerts" className="pt-0">
          <AlertsSection />
        </TabsContent>
        <TabsContent value="daily_summary" className="pt-0">
          <DailySummarySection />
        </TabsContent>
        <TabsContent value="multi_outlet" className="pt-0">
          <MultiOutletSection />
        </TabsContent>
      </Tabs>
    </OwnerBoardProvider>
  );
}
