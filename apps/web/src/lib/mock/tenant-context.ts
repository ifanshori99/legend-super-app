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
import { cafeLegendFixtures } from "@starter/shared/core";
import { API_MOCK } from "@/lib/api/mock-flag";
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
 * Tenant config for the current location's raw query string. Null means "no
 * config": outside mock mode, or `?tenant=none` in mock mode.
 */
export function resolveMockTenantContext(
  searchStr: string,
): TenantContextConfig | null {
  if (!API_MOCK) return null;
  const tenant = new URLSearchParams(searchStr).get("tenant");
  return tenant === "none" ? null : MOCK_TENANT_CONTEXT;
}
