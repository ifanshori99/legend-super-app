// Shared frame for every accounting back-office screen: page title, the tab
// strip between accounting sections, and the content slot. Tabs are links,
// not Radix tabs, because each section has its own URL (docs/frontend.md
// "Add a page"). PRD v1.7 §3.19, §5 "/kelola/*".
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  { key: "coa", labelKey: "accounting.tabs.coa", to: "/kelola/akuntansi" },
  {
    key: "journals",
    labelKey: "accounting.tabs.journals",
    to: "/kelola/akuntansi/jurnal",
  },
  {
    key: "manual",
    labelKey: "accounting.tabs.manual",
    to: "/kelola/akuntansi/jurnal-manual",
  },
  {
    key: "recurring",
    labelKey: "accounting.tabs.recurring",
    to: "/kelola/akuntansi/jurnal-berulang",
  },
] as const;

export type AccountingSection = (typeof TABS)[number]["key"];

export function AccountingTabs({ active }: { active: AccountingSection }) {
  const t = useT();
  return (
    <nav
      aria-label={t("accounting.title")}
      className={cn(tabsListClass, "[scrollbar-width:none]")}
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            // Exact match only: a parent link must not keep its own
            // aria-current on a child section (two current tabs, legend-jda7).
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

export function AccountingPage({
  active,
  children,
}: {
  active: AccountingSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    // The management topbar owns the page title (DESIGN.md v3 §5): no second
    // h1 and no extra gutter here. Detail screens render their own h2.
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("accounting.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      <AccountingTabs active={active} />
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
