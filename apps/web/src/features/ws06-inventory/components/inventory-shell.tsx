// Shared frame for the stock-control screens: page title, the tab strip
// between sections, and the content slot. Tabs are links, not Radix tabs,
// because each section has its own URL (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
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
] as const;

export type InventorySection = (typeof TABS)[number]["key"];

export function InventoryTabs({ active }: { active: InventorySection }) {
  const t = useT();
  return (
    <nav
      aria-label={t("inventoryStock.title")}
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {TABS.map((tab) => {
        // Each screen names its own section; a pathname prefix would mark
        // "Kartu Stok" current on every /kelola/inventori/* page.
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            // On 390px the strip scrolls; keep the current tab in view.
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
            className={cn(
              "-mb-px inline-flex min-h-control-sm shrink-0 items-center border-b-2 border-transparent px-3 text-(length:--density-text) font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground",
              current && "border-primary font-semibold text-foreground",
            )}
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
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl leading-7 font-semibold">
            {t("inventoryStock.title")}
          </h1>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventoryStock.subtitle")}
        </p>
      </header>
      <InventoryTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
