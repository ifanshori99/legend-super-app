// Shared frame for the tenant settings screens: the tab strip between the four
// sections, page actions and the content slot. Same pattern as the access
// screens: tabs are links because each section has its own URL
// (docs/frontend.md "Add a page"); the shell topbar owns the page title.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { PermissionCode } from "@starter/shared/access";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";

const TABS = [
  {
    key: "integrations",
    labelKey: "tenantSettings.tabs.integrations",
    to: "/kelola/pengaturan/integrasi",
    anyOf: ["org.integration.manage"],
  },
  {
    key: "theme",
    labelKey: "tenantSettings.tabs.theme",
    to: "/kelola/pengaturan/tema",
    anyOf: ["org.theme.manage"],
  },
  {
    key: "terms",
    labelKey: "tenantSettings.tabs.terms",
    // Term dictionary: Super Admin only (PRD §3 F4 "Teks & Kamus Istilah").
    to: "/kelola/pengaturan/istilah",
    anyOf: ["platform.tenant.manage"],
  },
  {
    key: "config",
    labelKey: "tenantSettings.tabs.config",
    to: "/kelola/pengaturan/konfigurasi",
    anyOf: ["org.config.export"],
  },
] as const satisfies readonly {
  key: string;
  labelKey: string;
  to: string;
  anyOf: readonly PermissionCode[];
}[];

export type SettingsSection = (typeof TABS)[number]["key"];

export function SettingsPage({
  active,
  access,
  actions,
  children,
}: {
  active: SettingsSection;
  access: AreaAccess;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const visible = TABS.filter(
    (tab) => tab.key === active || holdsAny(access, tab.anyOf),
  );
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <nav
            aria-label={t("tenantSettings.title")}
            className={cn(tabsListClass, "min-w-0")}
          >
            {visible.map((tab) => {
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
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        {actions}
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
