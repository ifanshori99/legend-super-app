// Shared frame for the two roster screens: subtitle, the tab strip between
// sections, and the content slot. Tabs are links, not Radix tabs, because each
// section has its own URL (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  { key: "roster", labelKey: "roster.tabs.roster", to: "/kelola/roster" },
  {
    key: "templates",
    labelKey: "roster.tabs.templates",
    to: "/kelola/roster/template",
  },
] as const;

export type RosterSection = (typeof TABS)[number]["key"];

export function RosterTabs({ active }: { active: RosterSection }) {
  const t = useT();
  return (
    <nav aria-label={t("roster.title")} className={cn(tabsListClass)}>
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            activeOptions={{ exact: true }}
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

export function RosterShell({
  active,
  children,
}: {
  active: RosterSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    // The management topbar owns the page title (DESIGN.md v3 §5): no second
    // h1 and no extra gutter here.
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("roster.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      <RosterTabs active={active} />
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
