// Shared frame for the RBAC admin screens: the tab strip between the access
// sections, page actions and the content slot. v3 (DESIGN.md §5 Management):
// the shell topbar owns the page title, so the frame only renders the section
// tab group (same look as <Tabs>) with the "Contoh data" badge. Tabs are
// links, not Radix tabs, because each section has its own URL
// (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  { key: "roles", labelKey: "access.tabs.roles", to: "/kelola/akses" },
  {
    key: "assignments",
    labelKey: "access.tabs.assignments",
    to: "/kelola/akses/penugasan",
  },
  {
    key: "matrix",
    labelKey: "access.tabs.matrix",
    to: "/kelola/akses/matriks-approval",
  },
] as const;

export type AccessSection = (typeof TABS)[number]["key"];

export function AccessTabs({ active }: { active: AccessSection }) {
  const t = useT();
  return (
    <nav
      aria-label={t("access.title")}
      className={cn(tabsListClass, "min-w-0")}
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            activeOptions={{ exact: true }}
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

export function AccessPage({
  active,
  actions,
  children,
}: {
  active: AccessSection;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AccessTabs active={active} />
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        {actions}
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
