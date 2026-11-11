// Settings hub (PRD v1.7 §3 "Pengaturan"; beads legend-max2, legend-j0kd):
// "Pengaturan tenant" lists the four tenant settings pages as rows (mockup
// settings-hub-j0kd); every other tenant, brand and outlet configuration
// screen stays reachable under "Pengaturan lainnya", grouped by scope. Entries
// appear only for screens that exist in this build (useRouteAvailable) and
// that this visitor may open (their page guard's permission).
import { Link, useRouteContext } from "@tanstack/react-router";
import { ChevronRight, HandCoins, Settings, Store } from "lucide-react";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import type { AreaAccess } from "@/lib/areas/access";
import { useRouteAvailable } from "@/lib/use-route-available";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HUB_ITEMS,
  PRIMARY_HUB_KEYS,
  groupAvailable,
  type HubItem,
  type HubScope,
} from "../hub";

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
// `floor.open_bill_policy.manage`; keep this in step with the route.
const OPEN_BILL_ITEM: HubItem = {
  key: "openBillPolicy",
  scope: "outlet",
  to: "/kelola/pengaturan/open-bill",
  icon: HandCoins,
  nameKey: "openBillPolicy.hub.name",
  hintKey: "openBillPolicy.hub.hint",
  anyPermission: ["floor.open_bill_policy.manage"],
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
  // Fail closed: no access context means no permission-gated rows.
  const groups = groupAvailable(
    [...HUB_ITEMS, OUTLET_SETTINGS_ITEM, OPEN_BILL_ITEM],
    available,
    access?.permissions ?? [],
  );
  const all = groups.flatMap((group) => group.items);
  const rows = PRIMARY_HUB_KEYS.flatMap((key) =>
    all.filter((entry) => entry.key === key),
  );
  const more = groups
    .map((group) => ({
      scope: group.scope,
      items: group.items.filter(
        (entry) => !(PRIMARY_HUB_KEYS as readonly string[]).includes(entry.key),
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
        {t("auditSettings.hub.subtitle")}
      </p>
      {rows.length === 0 && more.length === 0 ? (
        <EmptyState
          icon={Settings}
          title={t("auditSettings.hub.empty.title")}
          description={t("auditSettings.hub.empty.hint")}
        />
      ) : (
        <>
          <section aria-labelledby="hub-primary" className="grid gap-3">
            <div className="grid gap-0.5">
              <h2 id="hub-primary" className="type-title">
                {t("auditSettings.hub.primary.title")}
              </h2>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("auditSettings.hub.primary.hint")}
              </p>
            </div>
            <CardShell>
              <CardShellBody>
                {rows.length === 0 ? (
                  <p className="px-4 py-4 text-sm leading-5 text-muted-foreground">
                    {t("auditSettings.hub.primary.none")}
                  </p>
                ) : (
                  <ul className="grid grid-cols-[minmax(0,1fr)] divide-y divide-border">
                    {rows.map((entry) => {
                      const Icon = entry.icon;
                      return (
                        <li key={entry.key}>
                          <Link
                            // The router types know only today's routes; the
                            // availability check above guards the rest.
                            to={entry.to as "/kelola"}
                            className="flex min-h-22 items-center gap-4 px-4 py-4 transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                          >
                            <span className="grid size-11 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
                              <Icon className="size-5" aria-hidden="true" />
                            </span>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="text-base leading-6 font-semibold">
                                {t(entry.nameKey)}
                              </span>
                              <span className="text-sm leading-5 text-muted-foreground">
                                {t(entry.hintKey)}
                              </span>
                            </span>
                            <ChevronRight
                              className="size-5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardShellBody>
            </CardShell>
          </section>
          {more.length > 0 && (
            <section aria-labelledby="hub-more" className="grid gap-4">
              <div className="grid gap-0.5">
                <h2 id="hub-more" className="type-title">
                  {t("auditSettings.hub.more.title")}
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("auditSettings.hub.more.hint")}
                </p>
              </div>
              {more.map(({ scope, items }) => {
                const [titleKey, hintKey] = GROUP_KEYS[scope];
                const headingId = `hub-${scope}`;
                return (
                  <section
                    key={scope}
                    aria-labelledby={headingId}
                    className="grid gap-3"
                  >
                    <div className="grid gap-0.5">
                      <h3 id={headingId} className="text-sm font-semibold">
                        {t(titleKey)}
                      </h3>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {t(hintKey)}
                      </p>
                    </div>
                    <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {items.map((entry) => {
                        const Icon = entry.icon;
                        return (
                          <li key={entry.key} className="grid">
                            <CardShell className="h-full">
                              <CardShellBody className="h-full">
                                <Link
                                  to={entry.to as "/kelola"}
                                  className="flex h-full min-h-control items-start gap-3 px-4 py-3.5 transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                                >
                                  <span className="grid size-9 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
                                    <Icon
                                      className="size-4.5"
                                      aria-hidden="true"
                                    />
                                  </span>
                                  <span className="grid min-w-0 flex-1 gap-0.5">
                                    <span className="text-sm leading-5 font-semibold">
                                      {t(entry.nameKey)}
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
              })}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Route pending state (mockup "loading"): skeleton rows with a status label. */
export function SettingsHubPending() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("auditSettings.hub.loading.label")}
      aria-busy="true"
      className="grid gap-4"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="grid gap-2 py-2">
          <Skeleton className="h-4 w-[30%]" />
          <Skeleton className="h-4 w-[62%]" />
        </div>
      ))}
      <p className="text-sm text-muted-foreground">
        {t("auditSettings.hub.loading.text")}
      </p>
    </div>
  );
}

/** Route error state (mockup "error"): message and a retry button. */
export function SettingsHubError({ reset }: { reset?: () => void }) {
  const t = useT();
  return (
    <ErrorState
      title={t("auditSettings.hub.error.title")}
      description={t("auditSettings.hub.error.hint")}
      onRetry={reset}
    />
  );
}
