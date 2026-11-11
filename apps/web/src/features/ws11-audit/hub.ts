// Catalog of the settings hub (PRD v1.7 §3 "Pengaturan"): every tenant, brand
// and outlet configuration screen, by the scope it applies to. Entries point at
// screens other beads own; the hub shows an entry only when its route exists in
// this build (useRouteAvailable), so a screen that lands later lights up by
// itself and nothing links to a 404, and only when the visitor holds one of the
// permissions that screen's own page guard checks (`anyPermission`, mirrored
// from the route's beforeLoad / the owning feature's nav.ts), so the hub never
// offers a link that ends in "not found". Hiding is presentation; each page and
// the API still authorize. Text lives in `auditSettings.hub.items`.
import {
  ArrowLeftRight,
  BellRing,
  BookOpen,
  CaseSensitive,
  CreditCard,
  FolderTree,
  Gift,
  Layers,
  ListChecks,
  Lock,
  MapPin,
  Package,
  Palette,
  Percent,
  PlugZap,
  QrCode,
  Ruler,
  ScrollText,
  ShieldCheck,
  Soup,
  Tags,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import type { PermissionCode } from "@starter/shared/access";
import type { MessageKey } from "@starter/shared/i18n";

export const HUB_SCOPES = ["tenant", "brand", "outlet"] as const;
export type HubScope = (typeof HUB_SCOPES)[number];

export type HubItem = {
  key: string;
  scope: HubScope;
  /** Absolute path of the screen. */
  to: string;
  icon: LucideIcon;
  nameKey: MessageKey;
  hintKey: MessageKey;
  /** Shown only with one of these; absent = the management area guard suffices. */
  anyPermission?: readonly PermissionCode[];
};

function item(
  key: string,
  scope: HubScope,
  to: string,
  icon: LucideIcon,
  anyPermission?: readonly PermissionCode[],
): HubItem {
  return {
    key,
    scope,
    to,
    icon,
    nameKey: `auditSettings.hub.items.${key}.name` as MessageKey,
    hintKey: `auditSettings.hub.items.${key}.hint` as MessageKey,
    ...(anyPermission ? { anyPermission } : {}),
  };
}

const MENU_VIEW = ["menu.item.view"] as const;
const MENU_PRICE = ["menu.price.view"] as const;
const STOCK_VIEW = ["inventory.stock.view"] as const;

export const HUB_ITEMS: readonly HubItem[] = [
  item("access", "tenant", "/kelola/akses", ShieldCheck, ["access.role.view"]),
  item("integrations", "tenant", "/kelola/pengaturan/integrasi", PlugZap, [
    "org.integration.manage",
  ]),
  item("theme", "tenant", "/kelola/pengaturan/tema", Palette, [
    "org.theme.manage",
  ]),
  // Super Admin only: the page guard checks the platform permission.
  item("terms", "tenant", "/kelola/pengaturan/istilah", CaseSensitive, [
    "platform.tenant.manage",
  ]),
  item("config", "tenant", "/kelola/pengaturan/konfigurasi", ArrowLeftRight, [
    "org.config.export",
  ]),
  item("security", "tenant", "/kelola/keamanan", Lock),
  item("notifications", "tenant", "/kelola/notifikasi", BellRing),
  item("tax", "tenant", "/kelola/pajak", Percent, ["org.tax_config.manage"]),
  item("payments", "tenant", "/kelola/pembayaran", CreditCard, [
    "payment.transaction.view",
    "payment.reconcile",
    "payment.edc.manage",
  ]),
  item("accounting", "tenant", "/kelola/akuntansi", BookOpen, [
    "accounting.journal.view",
  ]),
  item("audit", "tenant", "/audit", ScrollText, ["audit.log.view"]),
  item("menu", "brand", "/kelola/menu", UtensilsCrossed, MENU_VIEW),
  item(
    "menuCategories",
    "brand",
    "/kelola/menu/kategori",
    FolderTree,
    MENU_VIEW,
  ),
  item("menuPrices", "brand", "/kelola/menu/harga", Tags, MENU_PRICE),
  item("menuBundles", "brand", "/kelola/menu/paket", Package, MENU_PRICE),
  item("loyalty", "brand", "/kelola/loyalty", Gift, ["loyalty.program.manage"]),
  item(
    "inventoryUnits",
    "brand",
    "/kelola/inventori/satuan",
    Ruler,
    STOCK_VIEW,
  ),
  item(
    "inventoryCategories",
    "brand",
    "/kelola/inventori/kategori",
    Layers,
    STOCK_VIEW,
  ),
  item("tables", "outlet", "/kelola/meja", QrCode, ["floor.table.manage"]),
  item("stations", "outlet", "/kelola/menu/stasiun", Soup, MENU_VIEW),
  item(
    "availability",
    "outlet",
    "/kelola/menu/ketersediaan",
    ListChecks,
    MENU_VIEW,
  ),
  item(
    "inventoryLocations",
    "outlet",
    "/kelola/inventori/lokasi",
    MapPin,
    STOCK_VIEW,
  ),
];

/**
 * The four rows of the hub's main list (mockup settings-hub-j0kd), in order.
 * Every other entry is listed under "Pengaturan lainnya" so it stays reachable.
 */
export const PRIMARY_HUB_KEYS = [
  "integrations",
  "theme",
  "terms",
  "config",
] as const;

/**
 * Items grouped by scope, keeping only those whose route exists and whose
 * permission the visitor holds. Without `permissions` (unit tests of route
 * availability) the permission check is skipped.
 */
export function groupAvailable(
  items: readonly HubItem[],
  available: (path: string) => boolean,
  permissions?: readonly string[],
): { scope: HubScope; items: HubItem[] }[] {
  const allowed = (entry: HubItem) =>
    permissions === undefined ||
    entry.anyPermission === undefined ||
    entry.anyPermission.some((code) => permissions.includes(code));
  return HUB_SCOPES.map((scope) => ({
    scope,
    items: items.filter(
      (entry) => entry.scope === scope && available(entry.to) && allowed(entry),
    ),
  })).filter((group) => group.items.length > 0);
}
