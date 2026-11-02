// Shared frame for the tax back-office screens: page title, the tab strip
// between configuration sections and the monthly report, and the content slot.
// Tabs are links, not Radix tabs, because each section has its own URL and its
// own guard (docs/frontend.md "Add a page").
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { MessageKey } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

type TaxTab = {
  key: "rules" | "service-charge" | "settings" | "report";
  labelKey: MessageKey;
  to:
    | "/kelola/pajak"
    | "/kelola/pajak/service-charge"
    | "/kelola/pajak/opsi"
    | "/kelola/pajak/laporan";
  /** Finance-only; hidden without accounting.tax_report.manage. */
  reportOnly?: boolean;
};

const TABS: readonly TaxTab[] = [
  { key: "rules", labelKey: "tax.tabs.rules", to: "/kelola/pajak" },
  {
    key: "service-charge",
    labelKey: "tax.tabs.serviceCharge",
    to: "/kelola/pajak/service-charge",
  },
  {
    key: "settings",
    labelKey: "tax.tabs.settings",
    to: "/kelola/pajak/opsi",
  },
  {
    key: "report",
    labelKey: "tax.tabs.report",
    to: "/kelola/pajak/laporan",
    reportOnly: true,
  },
];

export type TaxSection = TaxTab["key"];

export function TaxPage({
  active,
  title,
  description,
  canConfigure,
  canReport,
  children,
}: {
  active: TaxSection;
  title: string;
  description: string;
  canConfigure: boolean;
  canReport: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const tabs = TABS.filter((tab) =>
    tab.reportOnly ? canReport : canConfigure,
  );
  return (
    // The management topbar already renders the area h1 (DESIGN.md v3 §5);
    // the section title stays an h2 so each screen keeps one landmark.
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {title !== t("tax.title") && <h2 className="type-title">{title}</h2>}
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      </header>
      {tabs.length > 1 && (
        <nav
          aria-label={t("tax.title")}
          className={cn(tabsListClass, "[scrollbar-width:none]")}
        >
          {tabs.map((tab) => {
            const current = tab.key === active;
            return (
              <Link
                key={tab.key}
                to={tab.to}
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
      )}
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
