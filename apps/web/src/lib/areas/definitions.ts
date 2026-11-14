// Route areas of the web app (PRD v1.7 §3 F3, §5 "Peta situs dan strategi
// render"). One entry per area: which URL prefixes it owns, which design
// density and shell it renders with (PRD §3 F1, DESIGN.md §1), and the guard
// that decides who may open it. Data only — routes, layouts and tests read it.
//
// Guards here are presentation: they hide screens the API would refuse anyway.
// The API re-checks every request (TEN-02, AUTH-05).
import type { AppSurface, PermissionCode } from "@starter/shared/access";
import type { MessageKey } from "@starter/shared/i18n";
import type { Density } from "@starter/shared/theme";

export const AREA_KEYS = [
  "public",
  "customer",
  "ops",
  "kitchen",
  "kelola",
  "owner",
  "shareholder",
  "karyawan",
  "platform",
] as const;
export type AreaKey = (typeof AREA_KEYS)[number];

export type AreaShell = "customer" | "operations" | "management";

/**
 * none: anyone. session: any signed-in account (a member). permission: the
 * session must hold one of `anyOf` (RBAC §3.7); `surface` decides whether the
 * second factor applies (AUTH-05).
 */
export type AreaGuard =
  | { readonly kind: "none" }
  | { readonly kind: "session" }
  | {
      readonly kind: "permission";
      readonly anyOf: readonly PermissionCode[];
      readonly surface: AppSurface;
    };

export type AreaDefinition = {
  readonly key: AreaKey;
  /** URL prefixes the area owns (PRD §5). "/" matches only the root. */
  readonly basePaths: readonly string[];
  /** The area's placeholder / landing page, first item of its navigation. */
  readonly indexPath: string;
  readonly density: Density;
  readonly shell: AreaShell;
  readonly guard: AreaGuard;
  /** PRD §5 "Dilayani edge node": must keep working with the internet down. */
  readonly servedBy: "cloud" | "edge";
  /** PRD §5 "Diindeks: Tidak" → robots noindex on every page of the area. */
  readonly noindex: boolean;
  /** Kitchen screens are always dark (PRD: mode gelap untuk dapur). */
  readonly forcedMode?: "dark";
  readonly nameKey: MessageKey;
  readonly emptyTitleKey: MessageKey;
  readonly emptyHintKey: MessageKey;
};

/** Guard for member pages (`/member/*`): a signed-in customer, no role. */
export const SESSION_GUARD: AreaGuard = { kind: "session" };

export const AREAS: Readonly<Record<AreaKey, AreaDefinition>> = {
  public: {
    key: "public",
    basePaths: ["/", "/menu", "/reservasi", "/masuk"],
    indexPath: "/",
    density: "hangat",
    shell: "customer",
    guard: { kind: "none" },
    servedBy: "cloud",
    noindex: false,
    nameKey: "area.public.name",
    emptyTitleKey: "area.public.emptyTitle",
    emptyHintKey: "area.public.emptyHint",
  },
  customer: {
    key: "customer",
    basePaths: ["/t", "/f", "/member", "/wifi"],
    indexPath: "/member",
    density: "hangat",
    shell: "customer",
    guard: { kind: "none" },
    servedBy: "cloud",
    noindex: true,
    nameKey: "area.customer.name",
    emptyTitleKey: "area.customer.emptyTitle",
    emptyHintKey: "area.customer.emptyHint",
  },
  ops: {
    key: "ops",
    basePaths: ["/pos", "/fasilitas", "/operasional"],
    indexPath: "/pos",
    density: "kontras",
    shell: "operations",
    guard: {
      kind: "permission",
      surface: "pos",
      anyOf: [
        "pos.sale.create",
        "order.create",
        "shift.cash.operate",
        "wifi.voucher.issue",
        "facility.booth.operate",
        "facility.access.assist",
        "facility.emergency.respond",
        "ops.checklist.complete",
        "ops.food_safety.log",
        "ops.prep.manage",
        "ops.equipment.maintain",
        "ops.handover.record",
      ],
    },
    servedBy: "edge",
    noindex: true,
    nameKey: "area.ops.name",
    emptyTitleKey: "area.ops.emptyTitle",
    emptyHintKey: "area.ops.emptyHint",
  },
  kitchen: {
    key: "kitchen",
    basePaths: ["/kds", "/expo", "/pickup"],
    indexPath: "/kds",
    density: "kontras",
    shell: "operations",
    guard: {
      kind: "permission",
      surface: "kds",
      anyOf: ["kds.ticket.process", "kds.expo.operate", "kds.station.manage"],
    },
    servedBy: "edge",
    noindex: true,
    forcedMode: "dark",
    nameKey: "area.kitchen.name",
    emptyTitleKey: "area.kitchen.emptyTitle",
    emptyHintKey: "area.kitchen.emptyHint",
  },
  kelola: {
    key: "kelola",
    basePaths: ["/kelola", "/reports", "/audit"],
    indexPath: "/kelola",
    density: "padat",
    shell: "management",
    guard: {
      kind: "permission",
      surface: "dashboard",
      anyOf: ["dashboard.management.view"],
    },
    servedBy: "cloud",
    noindex: true,
    nameKey: "area.kelola.name",
    emptyTitleKey: "area.kelola.emptyTitle",
    emptyHintKey: "area.kelola.emptyHint",
  },
  owner: {
    key: "owner",
    basePaths: ["/owner"],
    indexPath: "/owner",
    density: "padat",
    shell: "management",
    guard: {
      kind: "permission",
      surface: "dashboard",
      anyOf: ["dashboard.owner.view"],
    },
    servedBy: "cloud",
    noindex: true,
    nameKey: "area.owner.name",
    emptyTitleKey: "area.owner.emptyTitle",
    emptyHintKey: "area.owner.emptyHint",
  },
  shareholder: {
    key: "shareholder",
    basePaths: ["/shareholder"],
    indexPath: "/shareholder",
    density: "padat",
    shell: "management",
    guard: {
      kind: "permission",
      surface: "dashboard",
      anyOf: ["dashboard.shareholder.view"],
    },
    servedBy: "cloud",
    noindex: true,
    nameKey: "area.shareholder.name",
    emptyTitleKey: "area.shareholder.emptyTitle",
    emptyHintKey: "area.shareholder.emptyHint",
  },
  karyawan: {
    key: "karyawan",
    basePaths: ["/karyawan"],
    indexPath: "/karyawan",
    density: "hangat",
    shell: "customer",
    guard: {
      kind: "permission",
      surface: "hris",
      anyOf: ["self.profile.view"],
    },
    servedBy: "cloud",
    noindex: true,
    nameKey: "area.karyawan.name",
    emptyTitleKey: "area.karyawan.emptyTitle",
    emptyHintKey: "area.karyawan.emptyHint",
  },
  platform: {
    key: "platform",
    basePaths: ["/platform"],
    indexPath: "/platform",
    density: "padat",
    shell: "management",
    guard: {
      kind: "permission",
      surface: "back_office",
      anyOf: ["platform.tenant.manage", "platform.health.view"],
    },
    servedBy: "cloud",
    noindex: true,
    nameKey: "area.platform.name",
    emptyTitleKey: "area.platform.emptyTitle",
    emptyHintKey: "area.platform.emptyHint",
  },
};

/** Area priority when a visitor could open several (e.g. an owner). */
export const AREA_LIST: readonly AreaDefinition[] = AREA_KEYS.map(
  (key) => AREAS[key],
);

function ownsPath(basePath: string, pathname: string): boolean {
  if (basePath === "/") return pathname === "/";
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/** The area that owns a URL path, or null for paths outside PRD §5 (auth, starter examples). */
export function resolveAreaForPath(pathname: string): AreaDefinition | null {
  for (const area of AREA_LIST)
    if (area.basePaths.some((base) => ownsPath(base, pathname))) return area;
  return null;
}
