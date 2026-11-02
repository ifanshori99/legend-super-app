// Shared frame for the kitchen back-office screens: page title, the tab strip
// between kitchen sections, and the content slot. Each section has its own
// URL, so the tabs are links (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { API_MOCK } from "@/lib/api/mock-flag";

const TABS: readonly {
  key: KitchenConfigSection;
  labelKey: MessageKey;
  to: string;
}[] = [
  {
    key: "capacity",
    labelKey: "kitchenConfig.tabs.capacity",
    to: "/kelola/dapur",
  },
  {
    key: "serving",
    labelKey: "kitchenConfig.tabs.serving",
    to: "/kelola/dapur/laporan",
  },
  {
    key: "remake",
    labelKey: "kitchenConfig.tabs.remake",
    to: "/kelola/dapur/remake",
  },
];

export type KitchenConfigSection = "capacity" | "serving" | "remake";

export function KitchenConfigTabs({
  active,
}: {
  active: KitchenConfigSection;
}) {
  const t = useT();
  return (
    <nav
      aria-label={t("kitchenConfig.title")}
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
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

export function KitchenConfigPage({
  active,
  children,
}: {
  active: KitchenConfigSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl leading-7 font-semibold">
            {t("kitchenConfig.title")}
          </h1>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("kitchenConfig.subtitle")}
        </p>
      </header>
      <KitchenConfigTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
