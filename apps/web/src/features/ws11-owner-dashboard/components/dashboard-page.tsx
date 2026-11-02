// "/owner" — the owner dashboard, part 1 (PRD v1.7 §3 F34; bead legend-k8fk).
// The shell (ManagementShell, Padat density, dashboard.owner.view + MFA) comes
// from the area layout; this file owns the screen and the four part-1 sections.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RotateCw } from "lucide-react";
import { formatBusinessDate, formatOutletTime } from "../board";
import { useOwnerBoardContext, OwnerBoardProvider } from "../board-context";
import { useOwnerBoard, useOwnerDashboard } from "../hooks";
import { OperationsSection } from "./operations-section";
import { RealtimeSummarySection } from "./realtime-section";
import { SeatsSection } from "./seats-section";
import { ShowerSection } from "./shower-section";

function BoardHeader() {
  const t = useT();
  const board = useOwnerBoardContext();
  const { layout } = board;
  const isEstimate = layout.monitoringPeriod.status !== "closed";
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl leading-8 font-semibold tracking-tight">
            {t("ownerDashboard.title")}
          </h2>
          {isEstimate && <Badge tone="info">{t("ownerDashboard.estimate")}</Badge>}
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("ownerDashboard.businessDate", {
            date: formatBusinessDate(layout.businessDate),
          })}
          {board.lastUpdatedAt === null ? null : (
            <>
              {" · "}
              {t("ownerDashboard.updatedAt", {
                time: formatOutletTime(board.lastUpdatedAt),
              })}
            </>
          )}
        </p>
        {isEstimate && (
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            {t("ownerDashboard.estimateHint")}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={board.isFetching}
        onClick={board.refresh}
      >
        <RotateCw aria-hidden="true" />
        {t("ownerDashboard.refresh")}
      </Button>
    </header>
  );
}

export function OwnerDashboardPage() {
  const t = useT();
  const { data: layout } = useOwnerDashboard();
  const board = useOwnerBoard(layout);

  return (
    <OwnerBoardProvider board={board}>
      <div className="grid min-w-0 gap-5">
        <BoardHeader />
        <Tabs defaultValue="realtime_summary" className="min-w-0">
          <TabsList aria-label={t("ownerDashboard.tabsLabel")}>
            <TabsTrigger value="realtime_summary">
              {t("ownerDashboard.tabs.realtime")}
            </TabsTrigger>
            <TabsTrigger value="operations">
              {t("ownerDashboard.tabs.operations")}
            </TabsTrigger>
            <TabsTrigger value="shower">
              {t("ownerDashboard.tabs.shower")}
            </TabsTrigger>
            <TabsTrigger value="seats_wfc">
              {t("ownerDashboard.tabs.seats")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="realtime_summary" className="min-w-0">
            <RealtimeSummarySection />
          </TabsContent>
          <TabsContent value="operations" className="min-w-0">
            <OperationsSection />
          </TabsContent>
          <TabsContent value="shower" className="min-w-0">
            <ShowerSection />
          </TabsContent>
          <TabsContent value="seats_wfc" className="min-w-0">
            <SeatsSection />
          </TabsContent>
        </Tabs>
      </div>
    </OwnerBoardProvider>
  );
}
