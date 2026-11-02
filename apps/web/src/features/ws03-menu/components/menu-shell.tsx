// Shared frame for every menu back-office screen: the tab strip between menu
// sections and the content slot. v3 (DESIGN.md §5 Management): the shell
// topbar owns the page title, so the frame only renders the section tab group
// (same look as <Tabs>, tabsListClass/tabsTriggerClass) with the "Contoh
// data" badge. Tabs are links, not Radix tabs, because each section has its
// own URL (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  { key: "items", labelKey: "menu.tabs.items", to: "/kelola/menu" },
  {
    key: "categories",
    labelKey: "menu.tabs.categories",
    to: "/kelola/menu/kategori",
  },
  { key: "combos", labelKey: "menu.tabs.combos", to: "/kelola/menu/paket" },
  { key: "prices", labelKey: "menu.tabs.prices", to: "/kelola/menu/harga" },
  {
    key: "availability",
    labelKey: "menu.tabs.availability",
    to: "/kelola/menu/ketersediaan",
  },
  {
    key: "stations",
    labelKey: "menu.tabs.stations",
    to: "/kelola/menu/stasiun",
  },
] as const;

export type MenuSection = (typeof TABS)[number]["key"];

export function MenuTabs({ active }: { active: MenuSection }) {
  const t = useT();
  return (
    <nav aria-label={t("menu.title")} className={cn(tabsListClass, "min-w-0")}>
      {TABS.map((tab) => {
        // Each screen names its own section. A pathname prefix match marked
        // "Item" current on every /kelola/menu/* page (review legend-cyu.12).
        // Exact matching also stops the router from adding its own
        // aria-current to the parent "Item" link on a child section, which
        // left two current tabs in the same nav (legend-jda7).
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            activeOptions={{ exact: true }}
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
            className={tabsTriggerClass}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export function MenuPage({
  active,
  children,
}: {
  active: MenuSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <MenuTabs active={active} />
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
