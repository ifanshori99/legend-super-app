// Shared frame for the payroll-configuration screen: the section description,
// the tab strip between policies, components, statutory tables and THR, and
// the content slot. Tabs are links carrying a validated ?tab= search param,
// not Radix tabs, so the section survives a reload and can be linked
// (docs/frontend.md "Add a page").
import * as React from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

export const PAYROLL_CONFIG_TABS = [
  "policies",
  "components",
  "statutory",
  "thr",
] as const;
export type PayrollConfigTab = (typeof PAYROLL_CONFIG_TABS)[number];

const TAB_KEYS: Record<PayrollConfigTab, MessageKey> = {
  policies: "payrollConfig.tabs.policies",
  components: "payrollConfig.tabs.components",
  statutory: "payrollConfig.tabs.statutory",
  thr: "payrollConfig.tabs.thr",
};

export function isPayrollConfigTab(value: unknown): value is PayrollConfigTab {
  return (
    typeof value === "string" &&
    (PAYROLL_CONFIG_TABS as readonly string[]).includes(value)
  );
}

export function PayrollConfigPage({
  active,
  canRun,
  children,
}: {
  active: PayrollConfigTab;
  /** payroll.run: without it the write actions stay hidden/disabled. */
  canRun: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const activeRef = React.useRef<HTMLAnchorElement>(null);
  // On 390px the strip scrolls; keep the current tab in view.
  React.useEffect(() => {
    activeRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [active]);
  return (
    // The management topbar owns the page h1 (DESIGN.md v3 §5); the body adds
    // only its own description and sections.
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("payrollConfig.subtitle")}
        </p>
        {!canRun && (
          <p className="max-w-3xl text-sm leading-5 font-medium text-warning">
            {t("payrollConfig.readOnlyHint")}
          </p>
        )}
      </header>
      <nav
        aria-label={t("payrollConfig.tabsLabel")}
        className={cn(
          tabsListClass,
          "h-auto flex-wrap overflow-x-visible [scrollbar-width:none]",
        )}
      >
        {PAYROLL_CONFIG_TABS.map((tab) => {
          const current = tab === active;
          return (
            <Link
              key={tab}
              to="/kelola/payroll/pengaturan"
              search={{ tab }}
              ref={current ? activeRef : undefined}
              aria-current={current ? "page" : undefined}
              className={tabsTriggerClass}
            >
              {t(TAB_KEYS[tab])}
            </Link>
          );
        })}
      </nav>
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
