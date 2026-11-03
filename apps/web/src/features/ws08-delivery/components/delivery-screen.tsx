// Ojek online delivery ops (PRD v1.7 §3.23 "Integrasi Ojek Online" / F20, §4
// Alur G, D12 "Mode Manual"): the three platform channels with their store
// switch and menu sync, the incoming platform orders, and the commission
// reconciliation. The kelola area already supplies the shell, density and
// guard; this component owns the tabs and the outlet stopgap.
import { WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOnline } from "@/lib/use-online";
import { useDeliveryWrites } from "../access";
import { useOutlets } from "../hooks";
import { ChannelsTab } from "./channels-tab";
import { OrdersTab } from "./orders-tab";
import { ReconciliationTab } from "./reconciliation-tab";

export type DeliveryTab = "kanal" | "pesanan" | "rekonsiliasi";

function ScreenHeader({ outletName }: { outletName?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        {/* The management topbar owns the page h1 (the nav label). */}
        <h2 id="delivery-ops-title" className="sr-only">
          {t("deliveryOps.title")}
        </h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("deliveryOps.subtitle")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        {outletName && (
          <p className="text-sm font-semibold">
            {t("deliveryOps.outletContext", { name: outletName })}
          </p>
        )}
      </div>
    </div>
  );
}

/** Platform actions need the cloud: the screen says so before a click fails. */
function OfflineNotice() {
  const t = useT();
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-1.5 rounded-container border-(length:--border-w) bg-warning-subtle p-card"
    >
      <StatusPill status="warning" icon={WifiOff}>
        {t("deliveryOps.offlineTitle")}
      </StatusPill>
      <p className="text-sm leading-5 text-warning">
        {t("deliveryOps.offlineHint")}
      </p>
    </div>
  );
}

function ScreenSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-5">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      <Skeleton className="h-5 w-96 max-w-full" />
      <Skeleton className="h-10 w-72 max-w-full rounded-control" />
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-80 w-full rounded-shell" />
        ))}
      </div>
    </div>
  );
}

export function DeliveryScreen({
  tab,
  onTabChange,
}: {
  tab: DeliveryTab;
  onTabChange: (tab: DeliveryTab) => void;
}) {
  const t = useT();
  const online = useOnline();
  const outlets = useOutlets();
  const { canManageChannels, canHandleOrders } = useDeliveryWrites();
  const outlet =
    outlets.data?.data.find((row) => row.status === "active") ??
    outlets.data?.data[0];

  if (outlets.isPending) return <ScreenSkeleton />;

  if (outlets.isError)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <ScreenHeader />
        <ErrorState
          title={t("deliveryOps.screenErrorTitle")}
          description={t("deliveryOps.screenErrorHint")}
          onRetry={() => void outlets.refetch()}
        />
      </div>
    );

  if (!outlet)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <ScreenHeader />
        <EmptyState
          title={t("deliveryOps.noOutletTitle")}
          description={t("deliveryOps.noOutletHint")}
        />
      </div>
    );

  return (
    <section
      aria-labelledby="delivery-ops-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5"
    >
      <ScreenHeader outletName={outlet.name} />

      {!online && <OfflineNotice />}

      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as DeliveryTab)}
      >
        <TabsList aria-label={t("deliveryOps.tabs.label")}>
          <TabsTrigger value="kanal">{t("deliveryOps.tabs.kanal")}</TabsTrigger>
          <TabsTrigger value="pesanan">
            {t("deliveryOps.tabs.pesanan")}
          </TabsTrigger>
          <TabsTrigger value="rekonsiliasi">
            {t("deliveryOps.tabs.rekonsiliasi")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="kanal">
          <ChannelsTab
            outletId={outlet.id}
            timeZone={outlet.timeZone}
            canManage={canManageChannels}
            online={online}
          />
        </TabsContent>
        <TabsContent value="pesanan">
          <OrdersTab
            outletId={outlet.id}
            timeZone={outlet.timeZone}
            canHandle={canHandleOrders}
            online={online}
          />
        </TabsContent>
        <TabsContent value="rekonsiliasi">
          <ReconciliationTab outletId={outlet.id} timeZone={outlet.timeZone} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
