// Settings hub (PRD v1.7 §3 "Pengaturan"; bead legend-max2): one place that
// links every tenant, brand and outlet configuration screen. Cards appear only
// for screens that exist in this build (useRouteAvailable) and that this
// visitor may open (their page guard's permission), grouped by the scope the
// setting applies to.
import { Link, useRouteContext } from "@tanstack/react-router";
import { ChevronRight, HandCoins, Settings, Store } from "lucide-react";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import type { AreaAccess } from "@/lib/areas/access";
import { useRouteAvailable } from "@/lib/use-route-available";
import { HUB_ITEMS, groupAvailable, type HubItem, type HubScope } from "../hub";

// Outlet settings (bead legend-1mi5) adds itself here instead of editing the
// hub catalogue: this bead owns only this file. Same shape and visibility rules
// as the entries in `hub.ts`; the card lights up once the route exists and the
// visitor holds the permission the page guard checks.
const OUTLET_SETTINGS_ITEM: HubItem = {
  key: "outletSettings",
  scope: "outlet",
  to: "/kelola/pengaturan/outlet",
  icon: Store,
  nameKey: "auditSettings.hub.groups.outlet",
  hintKey: "auditSettings.hub.groups.outletHint",
  anyPermission: ["org.structure.manage"],
};

// Open-bill policy (bead legend-2zb5), same arrangement. Its page guard is
// `floor.table.manage` for now (step 1); keep this in step with the route.
const OPEN_BILL_ITEM: HubItem = {
  key: "openBillPolicy",
  scope: "outlet",
  to: "/kelola/pengaturan/open-bill",
  icon: HandCoins,
  nameKey: "openBillPolicy.hub.name",
  hintKey: "openBillPolicy.hub.hint",
  anyPermission: ["floor.table.manage"],
};

const GROUP_KEYS = {
  tenant: [
    "auditSettings.hub.groups.tenant",
    "auditSettings.hub.groups.tenantHint",
  ],
  brand: [
    "auditSettings.hub.groups.brand",
    "auditSettings.hub.groups.brandHint",
  ],
  outlet: [
    "auditSettings.hub.groups.outlet",
    "auditSettings.hub.groups.outletHint",
  ],
} as const satisfies Record<HubScope, readonly [string, string]>;

export function SettingsHubPage() {
  const t = useT();
  const available = useRouteAvailable();
  const { access } = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  // Fail closed: no access context means no permission-gated cards.
  const groups = groupAvailable(
    [...HUB_ITEMS, OUTLET_SETTINGS_ITEM, OPEN_BILL_ITEM],
    available,
    access?.permissions ?? [],
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
        {t("auditSettings.hub.subtitle")}
      </p>
      {groups.length === 0 ? (
        <EmptyState
          icon={Settings}
          title={t("auditSettings.hub.empty.title")}
          description={t("auditSettings.hub.empty.hint")}
        />
      ) : (
        groups.map(({ scope, items }) => {
          const [titleKey, hintKey] = GROUP_KEYS[scope];
          const headingId = `hub-${scope}`;
          return (
            <section
              key={scope}
              aria-labelledby={headingId}
              className="grid gap-3"
            >
              <div className="grid gap-0.5">
                <h2 id={headingId} className="type-title">
                  {t(titleKey)}
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t(hintKey)}
                </p>
              </div>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((entry) => {
                  const Icon = entry.icon;
                  const name = t(entry.nameKey);
                  return (
                    <li key={entry.key} className="grid">
                      <CardShell className="h-full">
                        <CardShellBody className="h-full">
                          <Link
                            // The router types know only today's routes; the
                            // availability check above guards the rest.
                            to={entry.to as "/kelola"}
                            className="flex h-full min-h-control items-start gap-3 px-4 py-3.5 transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                          >
                            <span className="grid size-9 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
                              <Icon className="size-4.5" aria-hidden="true" />
                            </span>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="text-sm leading-5 font-semibold">
                                {name}
                              </span>
                              <span className="text-sm leading-5 text-muted-foreground">
                                {t(entry.hintKey)}
                              </span>
                            </span>
                            <ChevronRight
                              className="mt-1 size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </Link>
                        </CardShellBody>
                      </CardShell>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
