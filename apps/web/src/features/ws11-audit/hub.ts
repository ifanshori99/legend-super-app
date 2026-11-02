// Catalog of the settings hub (PRD v1.7 §3 "Pengaturan"): every tenant, brand
// and outlet configuration screen, by the scope it applies to. Entries point at
// screens other beads own; the hub shows an entry only when its route exists in
// this build (useRouteAvailable), so a screen that lands later lights up by
// itself and nothing links to a 404. Text lives in `auditSettings.hub.items`.
import {
  BellRing,
  BookOpen,
  CreditCard,
  FolderTree,
  Gift,
  Layers,
  ListChecks,
  Lock,
  MapPin,
  Package,
  Percent,
  QrCode,
  Ruler,
  ScrollText,
  ShieldCheck,
  Soup,
  Tags,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
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
};

function item(
  key: string,
  scope: HubScope,
  to: string,
  icon: LucideIcon,
): HubItem {
  return {
    key,
    scope,
    to,
    icon,
    nameKey: `auditSettings.hub.items.${key}.name` as MessageKey,
    hintKey: `auditSettings.hub.items.${key}.hint` as MessageKey,
  };
}

export const HUB_ITEMS: readonly HubItem[] = [
  item("access", "tenant", "/kelola/akses", ShieldCheck),
  item("security", "tenant", "/kelola/keamanan", Lock),
  item("notifications", "tenant", "/kelola/notifikasi", BellRing),
  item("tax", "tenant", "/kelola/pajak", Percent),
  item("payments", "tenant", "/kelola/pembayaran", CreditCard),
  item("accounting", "tenant", "/kelola/akuntansi", BookOpen),
  item("audit", "tenant", "/audit", ScrollText),
  item("menu", "brand", "/kelola/menu", UtensilsCrossed),
  item("menuCategories", "brand", "/kelola/menu/kategori", FolderTree),
  item("menuPrices", "brand", "/kelola/menu/harga", Tags),
  item("menuBundles", "brand", "/kelola/menu/paket", Package),
  item("loyalty", "brand", "/kelola/loyalty", Gift),
  item("inventoryUnits", "brand", "/kelola/inventori/satuan", Ruler),
  item("inventoryCategories", "brand", "/kelola/inventori/kategori", Layers),
  item("tables", "outlet", "/kelola/meja", QrCode),
  item("stations", "outlet", "/kelola/menu/stasiun", Soup),
  item("availability", "outlet", "/kelola/menu/ketersediaan", ListChecks),
  item("inventoryLocations", "outlet", "/kelola/inventori/lokasi", MapPin),
];

/** Items grouped by scope, keeping only those whose route exists. */
export function groupAvailable(
  items: readonly HubItem[],
  available: (path: string) => boolean,
): { scope: HubScope; items: HubItem[] }[] {
  return HUB_SCOPES.map((scope) => ({
    scope,
    items: items.filter(
      (entry) => entry.scope === scope && available(entry.to),
    ),
  })).filter((group) => group.items.length > 0);
}
