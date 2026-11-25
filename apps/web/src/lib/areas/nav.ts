// Navigation per area as data (i18n keys, no text). The area's own index is
// always the first item; screens add theirs from `features/<ws>-<name>/nav.ts`
// (collected in nav-registry.ts) so parallel feature beads never edit one list.
import type { LucideIcon } from "lucide-react";
import type { PermissionCode } from "@starter/shared/access";
import { isSharedDeviceScreenAllowed } from "@starter/shared/access/shared-device-screens";
import { SHOWER_FACILITIES_RELEASED } from "@starter/shared/facility";
import type { MessageKey, Translate } from "@starter/shared/i18n";
import type { AreaAccess } from "./access.ts";
import { AREAS, type AreaKey } from "./definitions.ts";
import { holdsAny } from "./guard.ts";

/**
 * Management sidebar groups (DESIGN.md v2 §5, owner Q28), in display order.
 * Items without a group sit first, under the area index.
 */
export const NAV_GROUPS = ["operations", "finance", "team"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

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
  /** Sidebar group in the management shell; other shells ignore it. */
  readonly group?: NavGroup;
  /** Shower-room screen: hidden while SHOWER_FACILITIES_RELEASED is false (1269 F0). */
  readonly showerOnly?: boolean;
  /**
   * Kelola paths of this screen (the `to` itself or sub-screens) that read the
   * selected outlet from the tenant context. The management shell shows the
   * outlet picker only there (legend-sp41n). Matches the path and its children.
   */
  readonly outletScopedPaths?: readonly string[];
};

export type ResolvedNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  current: boolean;
  /** Translated group label; consecutive items share one heading. */
  group?: string;
};

/**
 * Bottom nav slots (DESIGN.md v2 §5: CustomerShell keeps ≤5 items, 64px, safe
 * area). A sixth destination squeezes every label on a 390px phone, so the
 * shell shows the first four and moves the rest into a "Lainnya" sheet
 * (bead legend-oibk).
 */
export const BOTTOM_NAV_MAX_SLOTS = 5;

/** First `maxSlots - 1` items stay in the bar; the rest go behind "Lainnya". */
export function splitBottomNav<T>(
  items: readonly T[],
  maxSlots: number = BOTTOM_NAV_MAX_SLOTS,
): { primary: readonly T[]; overflow: readonly T[] } {
  if (maxSlots < 2)
    throw new RangeError("splitBottomNav needs room for one item plus More");
  if (items.length <= maxSlots) return { primary: items, overflow: [] };
  return {
    primary: items.slice(0, maxSlots - 1),
    overflow: items.slice(maxSlots - 1),
  };
}

function groupRank(entry: AreaNavEntry): number {
  return entry.group ? NAV_GROUPS.indexOf(entry.group) + 1 : 0;
}

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
    .filter((entry) => !entry.showerOnly || SHOWER_FACILITIES_RELEASED)
    .filter(
      (entry) => !entry.anyPermission || holdsAny(access, entry.anyPermission),
    )
    // Shared tablet (founder Q29): only the allowlisted screens are offered.
    .filter(
      (entry) => !access.sharedDevice || isSharedDeviceScreenAllowed(entry.to),
    )
    .sort(
      (a, b) =>
        groupRank(a) - groupRank(b) || (a.order ?? 100) - (b.order ?? 100),
    );
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
    ...(entry.group ? { group: t(`nav.group.${entry.group}`) } : {}),
  }));
}
