// Navigation per area as data (i18n keys, no text). The area's own index is
// always the first item; screens add theirs from `features/<ws>-<name>/nav.ts`
// (collected in nav-registry.ts) so parallel feature beads never edit one list.
import type { LucideIcon } from "lucide-react";
import type { PermissionCode } from "@starter/shared/access";
import type { MessageKey, Translate } from "@starter/shared/i18n";
import type { AreaAccess } from "./access.ts";
import { AREAS, type AreaKey } from "./definitions.ts";
import { holdsAny } from "./guard.ts";

export type AreaNavEntry = {
  readonly area: AreaKey;
  readonly labelKey: MessageKey;
  /** Absolute path under one of the area's base paths. */
  readonly to: string;
  readonly icon: LucideIcon;
  /** Lower first; the area index is order 0. Default 100. */
  readonly order?: number;
  /** Hide the item unless the visitor holds one of these (UI only). */
  readonly anyPermission?: readonly PermissionCode[];
};

export type ResolvedNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  current: boolean;
};

function matches(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Visible items of an area for this visitor, sorted, longest path match current. */
export function buildAreaNav(input: {
  area: AreaKey;
  entries: readonly AreaNavEntry[];
  indexIcon: LucideIcon;
  access: AreaAccess;
  pathname: string;
  t: Translate;
}): ResolvedNavItem[] {
  const { area, entries, indexIcon, access, pathname, t } = input;
  const definition = AREAS[area];
  const all: AreaNavEntry[] = [
    {
      area,
      labelKey: definition.nameKey,
      to: definition.indexPath,
      icon: indexIcon,
      order: 0,
    },
    ...entries.filter((entry) => entry.area === area),
  ];
  const visible = all
    .filter(
      (entry) =>
        !entry.anyPermission || holdsAny(access, entry.anyPermission),
    )
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const current = visible
    .filter((entry) => matches(pathname, entry.to))
    .reduce<AreaNavEntry | null>(
      (best, entry) =>
        best === null || entry.to.length > best.to.length ? entry : best,
      null,
    );
  return visible.map((entry) => ({
    label: t(entry.labelKey),
    href: entry.to,
    icon: entry.icon,
    current: entry === current,
  }));
}
