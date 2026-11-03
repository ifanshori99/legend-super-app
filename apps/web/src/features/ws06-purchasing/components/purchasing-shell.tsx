// Shared frame for every purchasing back-office screen: the tab strip between
// purchasing sections and the content slot. Tabs are links, not Radix tabs,
// because each section has its own URL (docs/frontend.md "Add a page"); the
// look is the same v3 tab group as <InventoryTabs>
// (tabsListClass / tabsTriggerClass). v3 (DESIGN.md §5 Management): the shell
// topbar owns the page title, so the frame renders no h1 and no gutter.
import * as React from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  {
    key: "documents",
    labelKey: "invfeNav.purchasing.documents",
    to: "/kelola/pengadaan",
  },
  {
    key: "suppliers",
    labelKey: "invfeNav.purchasing.suppliers",
    to: "/kelola/pengadaan/supplier",
  },
  {
    key: "receiving",
    labelKey: "invfeNav.purchasing.receiving",
    to: "/kelola/pengadaan/penerimaan",
  },
  {
    key: "invoices",
    labelKey: "invfeNav.purchasing.invoices",
    to: "/kelola/pengadaan/faktur",
  },
  {
    key: "returns",
    labelKey: "invfeNav.purchasing.returns",
    to: "/kelola/pengadaan/retur",
  },
  {
    key: "petty",
    labelKey: "invfeNav.purchasing.petty",
    to: "/kelola/pengadaan/kecil",
  },
] as const;

export type PurchasingSection = (typeof TABS)[number]["key"];

export function PurchasingTabs({ active }: { active: PurchasingSection }) {
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
      aria-label={t("purchasing.title")}
      className={cn(tabsListClass, "[scrollbar-width:none]")}
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            // Exact match only: the parent link must not keep its own
            // aria-current on a child section (legend-jda7).
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

export function PurchasingFrame({
  active,
  children,
}: {
  active: PurchasingSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <PurchasingTabs active={active} />
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
        {children}
      </div>
    </div>
  );
}
