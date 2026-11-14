// Shared frame for the kitchen back-office screens: the tab strip between
// kitchen sections and the content slot. v3 (DESIGN.md §5 Management): the
// shell topbar owns the page title, so the frame only renders the section tab
// group (same look as <Tabs>) with the "Contoh data" badge. Each section has
// its own URL, so the tabs are links (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback-state";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";

const TABS: readonly {
  key: KitchenConfigSection;
  labelKey: MessageKey;
  to: string;
}[] = [
  {
    key: "capacity",
    labelKey: "kitchenConfig.tabs.capacity",
    to: "/kelola/dapur",
  },
  {
    key: "stations",
    labelKey: "kitchenConfig.tabs.stations",
    to: "/kelola/dapur/stasiun",
  },
  {
    key: "serving",
    labelKey: "kitchenConfig.tabs.serving",
    to: "/kelola/dapur/laporan",
  },
  {
    key: "remake",
    labelKey: "kitchenConfig.tabs.remake",
    to: "/kelola/dapur/remake",
  },
];

export type KitchenConfigSection =
  "capacity" | "stations" | "serving" | "remake";

export function KitchenConfigTabs({
  active,
}: {
  active: KitchenConfigSection;
}) {
  const t = useT();
  return (
    <nav
      aria-label={t("kitchenConfig.title")}
      className={cn(tabsListClass, "min-w-0")}
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            ref={
              current
                ? (node: HTMLAnchorElement | null) =>
                    node?.scrollIntoView?.({
                      block: "nearest",
                      inline: "nearest",
                    })
                : undefined
            }
            aria-current={current ? "page" : undefined}
            className={tabsTriggerClass}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export function KitchenConfigPage({
  active,
  children,
}: {
  active: KitchenConfigSection;
  children: ReactNode;
}) {
  const t = useT();
  const { outlet } = useTenantContext();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <KitchenConfigTabs active={active} />
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      {/* Keyed by outlet: switching outlet in the shell starts the section
          fresh, so filters, pages and open dialogs of the previous outlet
          cannot leak into this one. */}
      {outlet ? (
        <div key={outlet.id} className="grid min-w-0 gap-5">
          {children}
        </div>
      ) : (
        <EmptyState
          title={t("area.noOutletTitle")}
          description={t("area.noOutletHint")}
        />
      )}
    </div>
  );
}
