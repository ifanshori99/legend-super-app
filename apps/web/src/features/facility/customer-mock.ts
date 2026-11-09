// Mock handlers for the guest-facing facility reads (VITE_API_MOCK=true):
// price board, QR entry lookup and the signed-in customer's entitlement balance
// (beads legend-zjfi, legend-humf, legend-t3dl). Served from the
// @starter/shared/facility fixtures with the same allow-list the API applies, so
// no staff configuration reaches a guest screen in mock mode either.
import {
  cafeLegendFacilityFixtures as fx,
  entitlementBalance,
  getCurrentEntitlements,
  getFacilityCatalog,
  resolveFacilityEntry,
  type Facility,
  type PublicFacility,
} from "@starter/shared/facility";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { readFacilityAdminConfig } from "../facility-admin/mock.ts";
import { OUTLET_TIME_ZONE } from "./flow.ts";

const ME = fx.ids.customerC1;

// Admin edits live in the facility-admin store; reading from it keeps them
// across a refetch. Unknown ids fall back to the fixtures.
function facilityConfig(facilityId: string) {
  const edited = readFacilityAdminConfig(facilityId);
  if (edited) return edited;
  const facility = fx.facilities.find((item) => item.id === facilityId);
  if (!facility)
    throw new ApiError(404, "NOT_FOUND", "Fasilitas tidak ditemukan.");
  return {
    facility,
    areas: fx.areas.filter((item) => item.facilityId === facility.id),
    products: fx.products.filter((item) => item.facilityId === facility.id),
    addons: fx.addons.filter((item) => item.facilityId === facility.id),
    subscriptionPlans: fx.subscriptionPlans.filter(
      (item) => item.facilityId === facility.id,
    ),
  };
}

function toPublicFacility(facility: Facility): PublicFacility {
  return {
    id: facility.id,
    name: facility.name,
    type: facility.type,
    sessionMinutes: facility.sessionMinutes,
    operatingHours: facility.operatingHours,
    outletId: facility.outletId,
    timeZone: OUTLET_TIME_ZONE,
  };
}

registerMock(getFacilityCatalog, ({ query }) => {
  const config = facilityConfig(query.facilityId);
  const { facility } = config;
  return {
    data: {
      facility: toPublicFacility(facility),
      products: config.products
        .filter((item) => item.facilityId === facility.id && item.isActive)
        .sort((a, b) => a.priceIdr - b.priceIdr)
        .map(({ id, name, type, priceIdr, sessions, maxPerDay }) => ({
          id,
          name,
          type,
          priceIdr,
          sessions,
          maxPerDay,
        })),
      addons: config.addons
        .filter((item) => item.facilityId === facility.id && item.isEnabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ id, name, priceIdr, sortOrder }) => ({
          id,
          name,
          priceIdr,
          sortOrder,
        })),
      plans: config.subscriptionPlans
        .filter((item) => item.facilityId === facility.id && item.isActive)
        .sort((a, b) => a.priceIdr - b.priceIdr)
        .map(({ id, name, priceIdr, quotaPerPeriod, interval, maxPerDay }) => ({
          id,
          name,
          priceIdr,
          quotaPerPeriod,
          interval,
          maxPerDay,
        })),
    },
  };
});

registerMock(resolveFacilityEntry, ({ params }) => {
  // The token is the facility's public id until a QR token column exists.
  const { facility, areas } = facilityConfig(params.token);
  return {
    data: {
      facility: toPublicFacility(facility),
      areas: areas
        .filter((item) => item.facilityId === facility.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    },
  };
});

registerMock(getCurrentEntitlements, ({ query, scenario }) => {
  const { facility } = facilityConfig(query.facilityId);
  const at = new Date();
  const ledger = scenario === "empty" ? [] : fx.entitlementLedger;
  const balance = entitlementBalance(ledger, {
    customerProfileId: ME,
    facilityId: facility.id,
    at,
  });
  const grants = ledger
    .filter(
      (entry) =>
        entry.type === "grant" &&
        entry.customerProfileId === ME &&
        entry.facilityId === facility.id &&
        (entry.expiresAt === null ||
          Date.parse(entry.expiresAt) > at.getTime()),
    )
    .sort(
      (a, b) =>
        (a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)) -
        (b.expiresAt === null ? Infinity : Date.parse(b.expiresAt)),
    )
    .map((entry) => ({
      id: entry.id,
      source: entry.sourceType,
      sessions: entry.sessions,
      expiresAt: entry.expiresAt,
      grantedAt: entry.occurredAt,
    }));
  return { data: { balance, grants } };
});
