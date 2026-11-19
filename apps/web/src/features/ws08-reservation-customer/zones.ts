// Zone choices for the guest form. There is no public zone-list endpoint yet
// (follow-up bead: public outlet zones), so a real deployment offers no zone
// choice and the reservation is made without `zoneId` — the host assigns the
// table on arrival (RSV-01). Mock mode stands in with the sample outlet's
// active zones so the zone-dependent policy (private-room minimum spend and the
// 48-hour cancellation window, RSV-03) is visible in the demo, marked by the
// page's "Contoh data" badge.
import { API_MOCK } from "@/lib/api/mock-flag.ts";

export type ZoneOption = { id: string; name: string };

// Minimal sample zones (same ids and names as the sample outlet, sorted by
// floor order). Kept local so the QR-order sample module, which carries demo
// menu names, stays out of the production bundle.
const MOCK_ZONE_OPTIONS: readonly ZoneOption[] = [
  { id: "00000000-0000-4000-8000-000000000100", name: "Indoor Reguler" },
  { id: "00000000-0000-4000-8000-000000000101", name: "Taman Outdoor" },
  {
    id: "00000000-0000-4000-8000-000000000102",
    name: "Private Room Nusantara",
  },
  { id: "00000000-0000-4000-8000-000000000103", name: "WFC Corner" },
];

/** Zones the form may offer; empty when only a real API could supply names. */
export function zoneOptions(): readonly ZoneOption[] {
  return API_MOCK ? MOCK_ZONE_OPTIONS : [];
}

/** Zone label for a stored id (confirmation), when the name is known. */
export function zoneName(zoneId: string | null): string | null {
  if (!zoneId) return null;
  return MOCK_ZONE_OPTIONS.find((zone) => zone.id === zoneId)?.name ?? null;
}
