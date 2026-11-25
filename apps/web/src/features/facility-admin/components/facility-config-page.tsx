// /kelola/fasilitas/$facilityId — one facility's configuration (bead
// legend-er32). The management topbar owns the page title; this screen adds a
// secondary heading with the facility name plus a tab group for the seven
// configuration areas (PRD v1.7 §3 F25).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { isFacilityTypeReleased } from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api/errors";
import { useFacilityConfig, useMenuItemOptions } from "../hooks.ts";
import { facilityTypeLabel, summarizeOperatingHours } from "../lib.ts";
import { AddonsTab } from "./addons-tab";
import { AreasTab } from "./areas-tab";
import { EntitlementsTab } from "./entitlements-tab";
import { GeneralTab } from "./general-tab";
import { ProductsTab, type ConfigTabKey } from "./products-tab";
import { SubscriptionsTab } from "./subscriptions-tab";
import { WifiTab } from "./wifi-tab";

const TABS: readonly { key: ConfigTabKey; labelKey: MessageKey }[] = [
  { key: "general", labelKey: "facilityAdmin.config.tabsGeneral" },
  { key: "areas", labelKey: "facilityAdmin.config.tabsAreas" },
  { key: "products", labelKey: "facilityAdmin.config.tabsProducts" },
  { key: "entitlements", labelKey: "facilityAdmin.config.tabsEntitlements" },
  { key: "addons", labelKey: "facilityAdmin.config.tabsAddons" },
  {
    key: "subscriptions",
    labelKey: "facilityAdmin.config.tabsSubscriptions",
  },
  { key: "wifi", labelKey: "facilityAdmin.config.tabsWifi" },
];

export function FacilityConfigPage({ facilityId }: { facilityId: string }) {
  const t = useT();
  const configQuery = useFacilityConfig(facilityId);
  const menuQuery = useMenuItemOptions();
  const [tab, setTab] = React.useState<ConfigTabKey>("general");

  const back = (
    <Button asChild variant="outline" size="sm" data-slot="facility-back">
      <Link to="/kelola/fasilitas">
        <ArrowLeft aria-hidden="true" />
        {t("facilityAdmin.common.backToList")}
      </Link>
    </Button>
  );

  if (configQuery.isPending)
    return (
      <div
        data-slot="facility-config"
        className="grid grid-cols-[minmax(0,1fr)] gap-5"
      >
        {back}
        <div aria-busy="true" className="grid gap-5">
          <span className="sr-only">{t("common.loading")}</span>
          <div className="grid gap-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-5 w-full max-w-xl" />
          </div>
          <Skeleton className="h-11 w-full max-w-2xl rounded-control" />
          <Skeleton className="h-72 rounded-shell" />
        </div>
      </div>
    );

  // 1269 F0: a shower facility reads as not found while the shower is deferred.
  const hiddenShower =
    configQuery.data !== undefined &&
    !isFacilityTypeReleased(configQuery.data.facility.type);
  if (configQuery.isError || hiddenShower) {
    const error = configQuery.error;
    const offline =
      !hiddenShower &&
      error instanceof ApiError &&
      error.code === "NETWORK_ERROR";
    const notFound =
      hiddenShower || (error instanceof ApiError && error.status === 404);
    return (
      <div
        data-slot="facility-config"
        className="grid grid-cols-[minmax(0,1fr)] gap-5"
      >
        {back}
        <CardShell>
          <CardShellBody>
            <ErrorState
              title={
                notFound
                  ? t("facilityAdmin.config.notFoundTitle")
                  : offline
                    ? t("facilityAdmin.config.offlineTitle")
                    : t("facilityAdmin.config.loadError")
              }
              description={
                notFound
                  ? t("facilityAdmin.config.notFoundHint")
                  : offline
                    ? t("facilityAdmin.config.offlineHint")
                    : t("facilityAdmin.config.loadErrorHint")
              }
              onRetry={
                notFound
                  ? undefined
                  : () => {
                      void configQuery.refetch();
                    }
              }
              action={
                notFound ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to="/kelola/fasilitas">
                      <ArrowLeft aria-hidden="true" />
                      {t("facilityAdmin.common.backToList")}
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </CardShellBody>
        </CardShell>
      </div>
    );
  }

  const config = configQuery.data;
  if (!config) return null;

  const hours = summarizeOperatingHours(config.facility.operatingHours, t);
  const menuItems = menuQuery.data ?? [];

  return (
    <div
      data-slot="facility-config"
      className="grid grid-cols-[minmax(0,1fr)] gap-5"
    >
      {back}
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title">{config.facility.name}</h2>
          <Badge tone="neutral">
            {t(facilityTypeLabel[config.facility.type])}
          </Badge>
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("facilityAdmin.config.headerSummary", {
            session: config.facility.sessionMinutes,
            cleaning: config.facility.cleaningMinutes,
            hours: hours.join("; "),
          })}
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as ConfigTabKey)}
      >
        <TabsList aria-label={t("facilityAdmin.config.tabsLabel")}>
          {TABS.map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {t(item.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="general">
          <GeneralTab facilityId={facilityId} facility={config.facility} />
        </TabsContent>
        <TabsContent value="areas">
          <AreasTab facilityId={facilityId} config={config} />
        </TabsContent>
        <TabsContent value="products">
          <ProductsTab
            facilityId={facilityId}
            config={config}
            menuItems={menuItems}
            onOpenTab={setTab}
          />
        </TabsContent>
        <TabsContent value="entitlements">
          <EntitlementsTab
            facilityId={facilityId}
            config={config}
            menuItems={menuItems}
          />
        </TabsContent>
        <TabsContent value="addons">
          <AddonsTab facilityId={facilityId} config={config} />
        </TabsContent>
        <TabsContent value="subscriptions">
          <SubscriptionsTab facilityId={facilityId} config={config} />
        </TabsContent>
        <TabsContent value="wifi">
          <WifiTab facilityId={facilityId} config={config} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
