// Shared frame for the RBAC admin screens: page title, the tab strip between
// the access sections, and the content slot. Tabs are links, not Radix tabs,
// because each section has its own URL (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
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
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
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
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl leading-7 font-semibold">
              {t("access.title")}
            </h1>
            {API_MOCK && (
              <Badge tone="neutral">{t("common.sampleData")}</Badge>
            )}
          </div>
          {actions}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("access.subtitle")}
        </p>
      </header>
      <AccessTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
