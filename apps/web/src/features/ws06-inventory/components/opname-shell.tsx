// Shared frame for the two stock-control screens: page title, the tab strip
// between stock opname and waste, and the content slot. Tabs are links, not
// Radix tabs, because each section has its own URL (docs/frontend.md
// "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  {
    key: "counts",
    labelKey: "opname.tabs.counts",
    to: "/kelola/inventori/opname",
  },
  {
    key: "waste",
    labelKey: "opname.tabs.waste",
    to: "/kelola/inventori/waste",
  },
] as const;

export type OpnameSection = (typeof TABS)[number]["key"];

function OpnameTabs({ active }: { active: OpnameSection }) {
  const t = useT();
  return (
    <nav
      aria-label={t("opname.title")}
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
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

export function OpnamePage({
  active,
  children,
}: {
  active: OpnameSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl leading-7 font-semibold">{t("opname.title")}</h1>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("opname.subtitle")}
        </p>
      </header>
      <OpnameTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
