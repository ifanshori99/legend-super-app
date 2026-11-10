// Zone choices for the guest form. There is no public zone-list endpoint yet
// (follow-up bead: public outlet zones), so a real deployment offers no zone
// choice and the reservation is made without `zoneId` — the host assigns the
// table on arrival (RSV-01). Mock mode stands in with the sample outlet's
// active zones so the zone-dependent policy (private-room minimum spend and the
// 48-hour cancellation window, RSV-03) is visible in the demo, marked by the
// page's "Contoh data" badge.
import { cafeLegendQrOrderFixtures } from "@starter/shared/qr-order/sample";
import { API_MOCK } from "@/lib/api/mock-flag.ts";

export type ZoneOption = { id: string; name: string };

const MOCK_ZONE_OPTIONS: readonly ZoneOption[] = cafeLegendQrOrderFixtures.zones
  .filter((zone) => zone.status === "active")
  .slice()
  .sort((left, right) => left.sortOrder - right.sortOrder)
  .map((zone) => ({ id: zone.id, name: zone.name }));

/** Zones the form may offer; empty when only a real API could supply names. */
export function zoneOptions(): readonly ZoneOption[] {
  return API_MOCK ? MOCK_ZONE_OPTIONS : [];
}

/** Zone label for a stored id (confirmation), when the name is known. */
export function zoneName(zoneId: string | null): string | null {
  if (!zoneId) return null;
  return MOCK_ZONE_OPTIONS.find((zone) => zone.id === zoneId)?.name ?? null;
}
