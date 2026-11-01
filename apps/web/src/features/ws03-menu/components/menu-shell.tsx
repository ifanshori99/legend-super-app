// Shared frame for every menu back-office screen: page title, the tab strip
// between menu sections, and the content slot. Tabs are links, not Radix
// tabs, because each section has its own URL (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
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
  const { pathname } = useLocation();
  return (
    <nav
      aria-label={t("menu.title")}
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {TABS.map((tab) => {
        const current =
          tab.key === active ||
          (tab.key === "items"
            ? pathname === tab.to || pathname.startsWith(`${tab.to}/`)
            : pathname === tab.to);
        return (
          <Link
            key={tab.key}
            to={tab.to}
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

export function MenuPage({
  active,
  children,
}: {
  active: MenuSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl leading-7 font-semibold">{t("menu.title")}</h1>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("menu.subtitle")}
        </p>
      </header>
      <MenuTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
