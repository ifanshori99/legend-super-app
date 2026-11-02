// Shared frame for every loyalty back-office screen: page title, the tab strip
// between loyalty sections, and the content slot. Tabs are links, not Radix
// tabs, because each section has its own URL (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS = [
  { key: "program", labelKey: "loyalty.tabs.program", to: "/kelola/loyalty" },
  { key: "tiers", labelKey: "loyalty.tabs.tiers", to: "/kelola/loyalty/tier" },
  {
    key: "rewards",
    labelKey: "loyalty.tabs.rewards",
    to: "/kelola/loyalty/reward",
  },
  {
    key: "missions",
    labelKey: "loyalty.tabs.missions",
    to: "/kelola/loyalty/misi",
  },
] as const;

export type LoyaltySection = (typeof TABS)[number]["key"];

export function LoyaltyTabs({ active }: { active: LoyaltySection }) {
  const t = useT();
  return (
    <nav
      aria-label={t("loyalty.title")}
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {TABS.map((tab) => {
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

export function LoyaltyPage({
  active,
  children,
}: {
  active: LoyaltySection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl leading-7 font-semibold">
            {t("loyalty.title")}
          </h1>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("loyalty.subtitle")}
        </p>
      </header>
      <LoyaltyTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
