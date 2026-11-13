// Outlet time zone for the QR journey: the menu's outlet zone, falling back to
// the platform default while the menu is still loading (bead legend-8qri).
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";

export function outletTimeZone(
  menu: { outlet: { timeZone?: string | null } } | null | undefined,
): string {
  return menu?.outlet.timeZone ?? DEFAULT_TIME_ZONE;
}
