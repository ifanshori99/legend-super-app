// Mock tenant/outlet context (bead legend-ri1p). The API will serve this
// scope later (brand, outlet, time zone, business_day_cutoff, device/station);
// until then mock mode reads the Cafe Legend core fixtures: brand
// "Cafe Legend", outlet BDG-01 "Cafe Legend Bandung" in Asia/Jakarta with the
// owner Q39 default cutoff 04:00. Tenant and outlet ids stay in the fixtures;
// the client never invents one (TEN-02).
//
// `?tenant=none` switches to the fail-closed path, so the mock e2e can prove
// the shells still render without config (catalog brand, "Outlet belum
// dipilih"). Production has no config source yet, so the resolver returns
// null there and the shells use the same neutral copy.
//
// legend-5kop: the outlet settings screen persists the cutoff it saved
// (features/ws01-org/outlet-store.ts, sessionStorage). `savedOutletCutoff`
// reads that snapshot for the app-level resolver, so `useOutletClock()` on any
// route returns the saved cutoff. The read is browser-only; callers pass its
// result in after mount (see components/layout/area-frame.tsx) because the SSR
// server must keep the fixture default for hydration to match.
import {
  cafeLegendFixtures,
  type BusinessDayCutoff,
} from "@starter/shared/core";
import { API_MOCK } from "@/lib/api/mock-flag";
import { readSavedOutlet } from "../../features/ws01-org/outlet-store.ts";
import type { TenantContextConfig } from "@/lib/tenant-context";

const outlet = cafeLegendFixtures.outlets[0];

/** The config every mock screen runs on (Cafe Legend Bandung, BDG-01). */
export const MOCK_TENANT_CONTEXT: TenantContextConfig = {
  brandName: cafeLegendFixtures.brand.name,
  outlet: {
    id: outlet.id,
    name: outlet.name,
    timeZone: outlet.timeZone,
    businessDayCutoff: outlet.businessDayCutoff,
  },
  // No device pairing or station selection exists yet; the provider exposes
  // both for the bead that adds them, and null is the fail-closed value.
  device: null,
  station: null,
};

/**
 * The cutoff the outlet settings mock saved in this tab, or null during SSR,
 * outside mock mode, or before any save. Safe to call only on the client.
 */
export function savedOutletCutoff(outletId: string): BusinessDayCutoff | null {
  if (!API_MOCK) return null;
  return readSavedOutlet(outletId)?.businessDayCutoff ?? null;
}

/**
 * Tenant config for the current location's raw query string. Null means "no
 * config": outside mock mode, or `?tenant=none` in mock mode.
 *
 * `savedCutoff` is the client-only value from `savedOutletCutoff`; the caller
 * leaves it null on the render that must match the server HTML and supplies it
 * from an effect after hydration. It never revives the fail-closed path: a
 * null config stays null.
 */
export function resolveMockTenantContext(
  searchStr: string,
  savedCutoff: BusinessDayCutoff | null = null,
): TenantContextConfig | null {
  if (!API_MOCK) return null;
  const tenant = new URLSearchParams(searchStr).get("tenant");
  if (tenant === "none") return null;
  const baseOutlet = MOCK_TENANT_CONTEXT.outlet;
  if (!baseOutlet) return MOCK_TENANT_CONTEXT;
  return {
    ...MOCK_TENANT_CONTEXT,
    outlet: {
      ...baseOutlet,
      businessDayCutoff: savedCutoff ?? baseOutlet.businessDayCutoff,
    },
  };
}
