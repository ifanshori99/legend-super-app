// "/shareholder" — the shareholder dashboard (PRD v1.7 §3 F35, §4 Alur O;
// SH-01, SH-02, DASH-03). The ManagementShell topbar owns the page title; this
// file owns the toolbar and the three sections the layout grants.
import { CalendarDays, RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  formatDate,
  formatInstantTime,
  hasSection,
  DOCUMENTS_KEY,
  PROFIT_SHARE_KEY,
} from "../board.ts";
import { useShareholderBoard, useShareholderDashboard } from "../hooks";
import { BusinessSection } from "./business-section";
import { DocumentsSection } from "./documents-section";
import { ProfitShareSection } from "./profit-share-section";

export function ShareholderDashboardPage({
  permissions = [],
}: {
  /** The caller's permission codes; drill-down links need the report's own. */
  permissions?: readonly string[];
}) {
  const t = useT();
  const { data: layout } = useShareholderDashboard();
  const board = useShareholderBoard(layout);
  const showBusiness = layout.tiles.some(
    (tile) => tile.section === "business_condition",
  );
  const showProfit = hasSection(layout, PROFIT_SHARE_KEY);
  const showDocuments = hasSection(layout, DOCUMENTS_KEY);
  const first = showBusiness ? "business" : showProfit ? "profit" : "documents";

  return (
    <Tabs defaultValue={first} className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="grid gap-3">
        <TabsList aria-label={t("shareholderHome.tabsLabel")}>
          {showBusiness && (
            <TabsTrigger value="business" className="px-2.5 sm:px-3.5">
              {t("shareholderHome.tabs.business")}
            </TabsTrigger>
          )}
          {showProfit && (
            <TabsTrigger value="profit" className="px-2.5 sm:px-3.5">
              {t("shareholderHome.tabs.profitShare")}
            </TabsTrigger>
          )}
          {showDocuments && (
            <TabsTrigger value="documents" className="px-2.5 sm:px-3.5">
              {t("shareholderHome.tabs.documents")}
            </TabsTrigger>
          )}
        </TabsList>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground tabular">
            <CalendarDays
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0">
              {t("shareholderHome.updatedAt", {
                date: formatDate(layout.generatedAt.slice(0, 10)),
                time: formatInstantTime(layout.generatedAt),
              })}
            </span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={board.isFetching}
            onClick={board.refresh}
            className="self-end sm:self-auto"
          >
            <RotateCw aria-hidden="true" />
            {t("shareholderHome.refresh")}
          </Button>
        </div>
      </div>
      {showBusiness && (
        <TabsContent value="business" className="pt-0">
          <BusinessSection board={board} permissions={permissions} />
        </TabsContent>
      )}
      {showProfit && (
        <TabsContent value="profit" className="pt-0">
          <ProfitShareSection />
        </TabsContent>
      )}
      {showDocuments && (
        <TabsContent value="documents" className="pt-0">
          <DocumentsSection />
        </TabsContent>
      )}
    </Tabs>
  );
}
