// Shared frame for every inventory back-office screen: page title, the tab
// strip between sections, and the content slot. Tabs are links, not Radix
// tabs, because each section has its own URL (docs/frontend.md "Add a page").
import * as React from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  { key: "items", labelKey: "inventory.tabs.items", to: "/kelola/inventori" },
  {
    key: "categories",
    labelKey: "inventory.tabs.categories",
    to: "/kelola/inventori/kategori",
  },
  {
    key: "units",
    labelKey: "inventory.tabs.units",
    to: "/kelola/inventori/satuan",
  },
  {
    key: "locations",
    labelKey: "inventory.tabs.locations",
    to: "/kelola/inventori/lokasi",
  },
  {
    key: "transfers",
    labelKey: "inventory.tabs.transfers",
    to: "/kelola/inventori/transfer",
  },
  // Stock control (legend-vxj): stock card, balances & par, expiry, AI-08.
  {
    key: "stock",
    labelKey: "inventoryStock.tabs.stock",
    to: "/kelola/inventori/stok",
  },
  {
    key: "balances",
    labelKey: "inventoryStock.tabs.balances",
    to: "/kelola/inventori/saldo",
  },
  {
    key: "expiry",
    labelKey: "inventoryStock.tabs.expiry",
    to: "/kelola/inventori/kedaluwarsa",
  },
  {
    key: "suggestions",
    labelKey: "inventoryStock.tabs.suggestions",
    to: "/kelola/inventori/saran",
  },
  // Stock opname and waste (legend-fzx).
  {
    key: "opname",
    labelKey: "inventory.tabs.opname",
    to: "/kelola/inventori/opname",
  },
  {
    key: "waste",
    labelKey: "inventory.tabs.waste",
    to: "/kelola/inventori/waste",
  },
] as const;

export type InventorySection = (typeof TABS)[number]["key"];

export function InventoryTabs({ active }: { active: InventorySection }) {
  const t = useT();
  const activeRef = React.useRef<HTMLAnchorElement>(null);
  // The strip is wider than a phone: keep the current section in view.
  React.useEffect(() => {
    activeRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [active]);
  return (
    <nav
      aria-label={t("inventory.title")}
      className={cn(tabsListClass, "[scrollbar-width:none]")}
    >
      {TABS.map((tab) => {
        // Each screen names its own section; a pathname prefix would mark
        // "Item" current on every /kelola/inventori/* page.
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            // Exact match only: the parent link must not keep its own
            // aria-current on a child section (two current tabs, legend-jda7).
            activeOptions={{ exact: true }}
            ref={current ? activeRef : undefined}
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

export function InventoryPage({
  active,
  children,
}: {
  active: InventorySection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    // The management topbar owns the page title (DESIGN.md v3 §5): no second
    // h1 and no extra gutter here.
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventory.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      <InventoryTabs active={active} />
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
