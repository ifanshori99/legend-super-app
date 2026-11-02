// Shared frame for every accounting back-office screen: page title, the tab
// strip between accounting sections, and the content slot. Tabs are links,
// not Radix tabs, because each section has its own URL (docs/frontend.md
// "Add a page"). PRD v1.7 §3.19, §5 "/kelola/*".
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
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

export function AccountingPage({
  active,
  children,
  headingLevel = 1,
}: {
  active: AccountingSection;
  children: ReactNode;
  /** Section screens use h1; a detail/form screen renders its own h2 and
   *  keeps this frame's title at h1 for the landmark. */
  headingLevel?: 1 | 2;
}) {
  const t = useT();
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Heading className="text-xl leading-7 font-semibold">
            {t("accounting.title")}
          </Heading>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("accounting.subtitle")}
        </p>
      </header>
      <AccountingTabs active={active} />
      <div className="grid min-w-0 gap-4">{children}</div>
    </div>
  );
}
