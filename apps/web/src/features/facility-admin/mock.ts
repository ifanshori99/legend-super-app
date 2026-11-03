// Mock handlers for the facility admin endpoints (bead legend-er32,
// VITE_API_MOCK=true). They serve the @starter/shared/facility fixtures and
// apply the contract's own rules — the slot-config limit, unique unit codes,
// the entitlement rule shape, the cancellation policy and the Wi-Fi policy
// refinements — so invalid input fails the way the API will
// (docs/frontend.md "Typed endpoints and mock mode").
//
// GET /api/facility/config already has its one owner (features/facility/mock.ts,
// used by the customer screens); importing it registers that handler instead
// of duplicating it. The config read there serves seed fixtures, so each write
// below also mutates this module's store: writes compose within one runtime
// while a full reload starts from the fixtures again.
import type { z } from "zod";
import { zodIssuesToDetails } from "@starter/shared/api";
import {
  cafeLegendFacilityFixtures as fx,
  createFacilityAddon,
  createFacilityArea,
  createFacilityProduct,
  createFacilityUnit,
  createSubscriptionPlanEndpoint,
  entitlementRuleSchema,
  facilityAddonSchema,
  facilityAreaSchema,
  facilityProductSchema,
  facilitySchema,
  facilityUnitSchema,
  listFacilities,
  putEntitlementRule,
  putWifiPolicy,
  subscriptionPlanSchema,
  updateFacility,
  updateFacilityAddon,
  updateFacilityArea,
  updateFacilityProduct,
  updateSubscriptionPlan,
  wifiPolicySchema,
  type EntitlementRule,
  type Facility,
  type FacilityAddon,
  type FacilityArea,
  type FacilityProduct,
  type FacilityUnit,
  type SubscriptionPlan,
  type WifiPolicy,
} from "@starter/shared/facility";
import { ApiError } from "../../lib/api/errors.ts";
// Single owner of GET /api/facility/config (customer screens).
import "../facility/mock.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

type AdminState = {
  facilities: Facility[];
  areas: FacilityArea[];
  units: FacilityUnit[];
  products: FacilityProduct[];
  addons: FacilityAddon[];
  entitlementRules: EntitlementRule[];
  subscriptionPlans: SubscriptionPlan[];
  wifiPolicies: WifiPolicy[];
};

function seed(): AdminState {
  return {
    facilities: [...fx.facilities],
    areas: [...fx.areas],
    units: [...fx.units],
    products: [...fx.products],
    addons: [...fx.addons],
    entitlementRules: [...fx.entitlementRules],
    subscriptionPlans: [...fx.subscriptionPlans],
    wifiPolicies: [...fx.wifiPolicies],
  };
}

const store = createMockStore<AdminState>(seed);

/** Validates an assembled row with the contract schema the API would use. */
function validate<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Konfigurasi fasilitas tidak valid.",
      zodIssuesToDetails(result.error),
    );
  return result.data;
}

function newId(): string {
  return crypto.randomUUID();
}

function requireFacility(state: AdminState, facilityId: string): Facility {
  const facility = state.facilities.find((row) => row.id === facilityId);
  if (!facility)
    throw new ApiError(404, "NOT_FOUND", "Fasilitas tidak ditemukan.");
  return facility;
}

function requireArea(
  state: AdminState,
  areaId: string,
  facilityId?: string,
): FacilityArea {
  const area = state.areas.find(
    (row) =>
      row.id === areaId &&
      (facilityId === undefined || row.facilityId === facilityId),
  );
  if (!area)
    throw new ApiError(404, "NOT_FOUND", "Area fasilitas tidak ditemukan.");
  return area;
}

// ---- Facilities -------------------------------------------------------------

registerMock(listFacilities, ({ query, scenario }) =>
  paginateFixture(
    store.get().facilities,
    query,
    (facility) => facility.id,
    scenario,
  ),
);

registerMock(updateFacility, ({ params, body }) => {
  const state = store.get();
  const current = requireFacility(state, params.facilityId);
  const next = validate(facilitySchema, { ...current, ...body });
  // slotConfigSchema (contract): a slot may not exceed 12 hours including the
  // cleaning buffer, even though the PATCH body schema cannot express it.
  if (next.sessionMinutes + next.cleaningMinutes > 720)
    throw new ApiError(400, "VALIDATION_ERROR", "Slot terlalu panjang.", [
      {
        field: "cleaningMinutes",
        message:
          "Sesi ditambah jeda pembersihan tidak boleh melebihi 720 menit.",
      },
    ]);
  store.set({
    ...state,
    facilities: state.facilities.map((row) =>
      row.id === next.id ? next : row,
    ),
  });
  return { data: next };
});

// ---- Areas and units --------------------------------------------------------

registerMock(createFacilityArea, ({ body }) => {
  const state = store.get();
  const facility = requireFacility(state, body.facilityId);
  const area = validate(facilityAreaSchema, {
    id: newId(),
    tenantId: facility.tenantId,
    outletId: facility.outletId,
    facilityId: facility.id,
    name: body.name,
    entranceLockDeviceId: body.entranceLockDeviceId ?? null,
    sortOrder:
      body.sortOrder ??
      state.areas.filter((row) => row.facilityId === facility.id).length,
  });
  store.set({ ...state, areas: [...state.areas, area] });
  return { data: area };
});

registerMock(updateFacilityArea, ({ params, body }) => {
  const state = store.get();
  const current = requireArea(state, params.areaId);
  const next = validate(facilityAreaSchema, { ...current, ...body });
  store.set({
    ...state,
    areas: state.areas.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

registerMock(createFacilityUnit, ({ body }) => {
  const state = store.get();
  const facility = requireFacility(state, body.facilityId);
  requireArea(state, body.areaId, facility.id);
  const code = body.code.trim();
  // PRD §6 K: the unit code is unique per facility (P1, W2).
  if (
    state.units.some(
      (row) =>
        row.facilityId === facility.id &&
        row.code.toLocaleLowerCase("id-ID") === code.toLocaleLowerCase("id-ID"),
    )
  )
    throw new ApiError(
      409,
      "CONFLICT",
      "Kode unit ini sudah dipakai di fasilitas yang sama.",
    );
  const unit = validate(facilityUnitSchema, {
    id: newId(),
    tenantId: facility.tenantId,
    outletId: facility.outletId,
    facilityId: facility.id,
    areaId: body.areaId,
    code,
    lockDeviceId: body.lockDeviceId ?? null,
    panicDeviceId: body.panicDeviceId ?? null,
    // A new booth is ready to sell (PRD §3 F25 Siklus Kebersihan ends available).
    status: "available",
    sortOrder:
      body.sortOrder ??
      state.units.filter((row) => row.areaId === body.areaId).length,
  });
  store.set({ ...state, units: [...state.units, unit] });
  return { data: unit };
});

// ---- Products and add-ons ---------------------------------------------------

registerMock(createFacilityProduct, ({ body }) => {
  const state = store.get();
  const facility = requireFacility(state, body.facilityId);
  const product = validate(facilityProductSchema, {
    id: newId(),
    tenantId: facility.tenantId,
    outletId: facility.outletId,
    facilityId: facility.id,
    name: body.name,
    type: body.type,
    priceIdr: body.priceIdr,
    taxRuleId: body.taxRuleId ?? null,
    sessions: body.sessions,
    maxPerDay: body.maxPerDay ?? null,
    menuItemId: body.menuItemId ?? null,
    isActive: body.isActive ?? true,
  });
  store.set({ ...state, products: [...state.products, product] });
  return { data: product };
});

registerMock(updateFacilityProduct, ({ params, body }) => {
  const state = store.get();
  const current = state.products.find((row) => row.id === params.productId);
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Produk fasilitas tidak ditemukan.");
  const next = validate(facilityProductSchema, { ...current, ...body });
  store.set({
    ...state,
    products: state.products.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

registerMock(createFacilityAddon, ({ body }) => {
  const state = store.get();
  const facility = requireFacility(state, body.facilityId);
  const addon = validate(facilityAddonSchema, {
    id: newId(),
    tenantId: facility.tenantId,
    outletId: facility.outletId,
    facilityId: facility.id,
    name: body.name,
    priceIdr: body.priceIdr,
    inventoryItemId: body.inventoryItemId ?? null,
    isEnabled: body.isEnabled ?? true,
    sortOrder:
      body.sortOrder ??
      state.addons.filter((row) => row.facilityId === facility.id).length,
  });
  store.set({ ...state, addons: [...state.addons, addon] });
  return { data: addon };
});

registerMock(updateFacilityAddon, ({ params, body }) => {
  const state = store.get();
  const current = state.addons.find((row) => row.id === params.addonId);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Add-on tidak ditemukan.");
  const next = validate(facilityAddonSchema, { ...current, ...body });
  store.set({
    ...state,
    addons: state.addons.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

// ---- Entitlement rules ------------------------------------------------------

registerMock(putEntitlementRule, ({ params, body }) => {
  const state = store.get();
  const current = state.entitlementRules.find(
    (row) => row.id === params.ruleId,
  );
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Aturan hak akses tidak ditemukan.");
  if (body.facilityId !== current.facilityId)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Aturan hak akses bukan milik fasilitas ini.",
      [{ field: "facilityId", message: "Fasilitas tidak cocok." }],
    );
  const next = validate(entitlementRuleSchema, { ...current, ...body });
  store.set({
    ...state,
    entitlementRules: state.entitlementRules.map((row) =>
      row.id === next.id ? next : row,
    ),
  });
  return { data: next };
});

// ---- Subscription plans -----------------------------------------------------

registerMock(createSubscriptionPlanEndpoint, ({ body }) => {
  const state = store.get();
  const facility = requireFacility(state, body.facilityId);
  const plan = validate(subscriptionPlanSchema, {
    id: newId(),
    tenantId: facility.tenantId,
    outletId: facility.outletId,
    facilityId: facility.id,
    name: body.name,
    priceIdr: body.priceIdr,
    quotaPerPeriod: body.quotaPerPeriod,
    interval: body.interval,
    maxPerDay: body.maxPerDay ?? null,
    providerPlanId: body.providerPlanId ?? null,
    isActive: body.isActive ?? true,
  });
  store.set({
    ...state,
    subscriptionPlans: [...state.subscriptionPlans, plan],
  });
  return { data: plan };
});

registerMock(updateSubscriptionPlan, ({ params, body }) => {
  const state = store.get();
  const current = state.subscriptionPlans.find(
    (row) => row.id === params.planId,
  );
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Paket langganan tidak ditemukan.");
  const next = validate(subscriptionPlanSchema, { ...current, ...body });
  store.set({
    ...state,
    subscriptionPlans: state.subscriptionPlans.map((row) =>
      row.id === next.id ? next : row,
    ),
  });
  return { data: next };
});

// ---- Wi-Fi policies ---------------------------------------------------------

registerMock(putWifiPolicy, ({ params, body }) => {
  const state = store.get();
  const current = state.wifiPolicies.find((row) => row.id === params.policyId);
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Kebijakan Wi-Fi tidak ditemukan.");
  // `facilityId` is optional in the PUT body but is not a policy column; the
  // zone and the outlet scope identify it (PRD §6 C floor_zones).
  const next = validate(wifiPolicySchema, {
    ...current,
    zoneId: body.zoneId,
    freeMinutes: body.freeMinutes,
    peakFreeMinutes: body.peakFreeMinutes,
    spendPerExtraHourIdr: body.spendPerExtraHourIdr,
    extraMinutes: body.extraMinutes,
    maxDevices: body.maxDevices,
    peakSchedule: body.peakSchedule,
    baseSpeedKbps: body.baseSpeedKbps,
    fullSpeedKbps: body.fullSpeedKbps,
    minSpendPerHourIdr: body.minSpendPerHourIdr,
    tierBonusMinutes: body.tierBonusMinutes,
  });
  store.set({
    ...state,
    wifiPolicies: state.wifiPolicies.map((row) =>
      row.id === next.id ? next : row,
    ),
  });
  return { data: next };
});
