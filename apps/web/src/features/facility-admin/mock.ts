// Mock handlers for the facility admin endpoints (bead legend-er32,
// VITE_API_MOCK=true). They serve the @starter/shared/facility fixtures and
// apply the contract's own rules — the slot-config limit, unique unit codes,
// the entitlement rule shape, the cancellation policy and the Wi-Fi policy
// refinements — so invalid input fails the way the API will
// (docs/frontend.md "Typed endpoints and mock mode").
//
// GET /api/facility/config has one owner (features/facility/mock.ts, used by the
// customer screens). That handler reads this module's store through
// `readFacilityAdminConfig`, so an admin edit survives a refetch (bead
// legend-wbwl); a full reload starts from the fixtures again.
//
// Writes follow the API contract of bead legend-6jms: a PATCH/PUT whose
// `expectedUpdatedAt` is not the row's `updatedAt` answers 412, and a POST create
// with a known `idempotencyKey` returns the first row (another payload with the
// same key is a 409).
import type { z } from "zod";
import { zodIssuesToDetails } from "@starter/shared/api";
import {
  cafeLegendFacilityFixtures as fx,
  createFacilityAddon,
  createFacilityArea,
  createFacilityProduct,
  createFacility,
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
  updateFacilityUnitConfig,
  updateSubscriptionPlan,
  wifiPolicySchema,
  type EntitlementRule,
  type Facility,
  type FacilityConfig,
  type FacilityAddon,
  type FacilityArea,
  type FacilityProduct,
  type FacilityUnit,
  type SubscriptionPlan,
  type WifiPolicy,
} from "@starter/shared/facility";
import { ApiError } from "../../lib/api/errors.ts";
import { mockFacilities } from "../facility/mock-facilities.ts";
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
    facilities: mockFacilities(),
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

/** Bound idempotency keys: key -> payload fingerprint, row kind and row id. */
const idempotency = createMockStore<
  Map<string, { fingerprint: string; kind: string; id: string }>
>(() => new Map());

/**
 * The config of one facility as the admin has edited it. The customer-side
 * `GET /api/facility/config` mock answers from this, so a refetch (stale
 * time, focus) never wipes an edit (bead legend-wbwl). Undefined for an id the
 * store does not know; the caller falls back to its own fixtures.
 */
export function readFacilityAdminConfig(
  facilityId: string,
): FacilityConfig | undefined {
  const state = store.get();
  const facility = state.facilities.find((row) => row.id === facilityId);
  if (!facility) return undefined;
  return {
    facility,
    areas: state.areas.filter((row) => row.facilityId === facility.id),
    units: state.units.filter((row) => row.facilityId === facility.id),
    products: state.products.filter((row) => row.facilityId === facility.id),
    addons: state.addons.filter((row) => row.facilityId === facility.id),
    entitlementRules: state.entitlementRules.filter(
      (row) => row.facilityId === facility.id,
    ),
    subscriptionPlans: state.subscriptionPlans.filter(
      (row) => row.facilityId === facility.id,
    ),
    // A policy belongs to a floor zone of the outlet (facilityId is optional
    // on the policy), so every policy of the facility's outlet is listed.
    wifiPolicies: state.wifiPolicies.filter(
      (row) => row.outletId === facility.outletId,
    ),
  };
}

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

/** The version stamp every config row carries (`updatedAt`). */
function stamp(): string {
  return new Date().toISOString();
}

/** The API answers 412 when the editor's stamp is not the stored one. */
function assertFresh(current: string | null, expected: string | null) {
  if (current !== expected)
    throw new ApiError(
      412,
      "PRECONDITION_FAILED",
      "Data sudah diubah orang lain. Muat ulang lalu coba lagi.",
    );
}

/** The body of a PATCH/PUT without the concurrency stamp (not a column). */
function withoutStamp<T extends { expectedUpdatedAt: string | null }>(
  body: T,
): Omit<T, "expectedUpdatedAt"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit field
  const { expectedUpdatedAt: _stamp, ...rest } = body;
  return rest;
}

/**
 * Replays a create: the first row of a known key, an error when the key was
 * used for another payload or kind, null when the key is new.
 */
function replayCreate<T extends { id: string }>(
  kind: string,
  body: { idempotencyKey: string },
  rows: readonly T[],
): T | null {
  const { idempotencyKey, ...payload } = body;
  const prior = idempotency.get().get(idempotencyKey);
  if (!prior) return null;
  if (prior.fingerprint !== JSON.stringify(payload) || prior.kind !== kind)
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai permintaan lain.",
    );
  return rows.find((row) => row.id === prior.id) ?? null;
}

function rememberCreate(
  kind: string,
  body: { idempotencyKey: string },
  id: string,
) {
  const { idempotencyKey, ...payload } = body;
  idempotency.set(
    new Map(idempotency.get()).set(idempotencyKey, {
      fingerprint: JSON.stringify(payload),
      kind,
      id,
    }),
  );
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

/** slotConfigSchema (contract): a slot may not exceed 12 hours with cleaning. */
function assertSlotFits(facility: Facility) {
  if (facility.sessionMinutes + facility.cleaningMinutes > 720)
    throw new ApiError(400, "VALIDATION_ERROR", "Slot terlalu panjang.", [
      {
        field: "cleaningMinutes",
        message:
          "Sesi ditambah jeda pembersihan tidak boleh melebihi 720 menit.",
      },
    ]);
}

// ---- Facilities -------------------------------------------------------------

// Each row carries the sizes of its areas, units and products (legend-34fu),
// counted from the edited store so an admin edit shows in the next list read.
registerMock(listFacilities, ({ query, scenario }) => {
  const state = store.get();
  const count = (rows: readonly { facilityId: string }[], id: string) =>
    rows.filter((row) => row.facilityId === id).length;
  return paginateFixture(
    state.facilities.map((facility) => ({
      ...facility,
      areaCount: count(state.areas, facility.id),
      unitCount: count(state.units, facility.id),
      activeUnitCount: state.units.filter(
        (unit) =>
          unit.facilityId === facility.id && unit.status !== "maintenance",
      ).length,
      productCount: count(state.products, facility.id),
    })),
    query,
    (facility) => facility.id,
    scenario,
  );
});

registerMock(createFacility, ({ body }) => {
  const state = store.get();
  const replay = replayCreate("facility", body, state.facilities);
  if (replay) return { data: replay };
  const outlet = state.facilities.find((row) => row.outletId === body.outletId);
  if (!outlet) throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  const facility = validate(facilitySchema, {
    id: newId(),
    tenantId: outlet.tenantId,
    outletId: body.outletId,
    name: body.name,
    type: body.type,
    sessionMinutes: body.sessionMinutes,
    cleaningMinutes: body.cleaningMinutes,
    arrivalGraceMinutes: body.arrivalGraceMinutes,
    operatingHours: body.operatingHours,
    overtimePolicy: body.overtimePolicy,
    cancellationPolicy: body.cancellationPolicy,
    updatedAt: stamp(),
  });
  assertSlotFits(facility);
  store.set({ ...state, facilities: [...state.facilities, facility] });
  rememberCreate("facility", body, facility.id);
  return { data: facility };
});

registerMock(updateFacility, ({ params, body }) => {
  const state = store.get();
  const current = requireFacility(state, params.facilityId);
  assertFresh(current.updatedAt, body.expectedUpdatedAt);
  const next = validate(facilitySchema, {
    ...current,
    ...withoutStamp(body),
    updatedAt: stamp(),
  });
  assertSlotFits(next);
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
  const replay = replayCreate("area", body, state.areas);
  if (replay) return { data: replay };
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
    updatedAt: stamp(),
  });
  store.set({ ...state, areas: [...state.areas, area] });
  rememberCreate("area", body, area.id);
  return { data: area };
});

registerMock(updateFacilityArea, ({ params, body }) => {
  const state = store.get();
  const current = requireArea(state, params.areaId);
  assertFresh(current.updatedAt, body.expectedUpdatedAt);
  const next = validate(facilityAreaSchema, {
    ...current,
    ...withoutStamp(body),
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    areas: state.areas.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

/** PRD §6 K: the unit code is unique per facility (P1, W2). */
function assertUnitCodeFree(
  state: AdminState,
  facilityId: string,
  code: string,
  exceptUnitId?: string,
) {
  if (
    state.units.some(
      (row) =>
        row.facilityId === facilityId &&
        row.id !== exceptUnitId &&
        row.code.toLocaleLowerCase("id-ID") === code.toLocaleLowerCase("id-ID"),
    )
  )
    throw new ApiError(
      409,
      "CONFLICT",
      "Kode unit ini sudah dipakai di fasilitas yang sama.",
    );
}

registerMock(createFacilityUnit, ({ body }) => {
  const state = store.get();
  const replay = replayCreate("unit", body, state.units);
  if (replay) return { data: replay };
  const facility = requireFacility(state, body.facilityId);
  requireArea(state, body.areaId, facility.id);
  const code = body.code.trim();
  assertUnitCodeFree(state, facility.id, code);
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
    updatedAt: stamp(),
  });
  store.set({ ...state, units: [...state.units, unit] });
  rememberCreate("unit", body, unit.id);
  return { data: unit };
});

registerMock(updateFacilityUnitConfig, ({ params, body }) => {
  const state = store.get();
  const current = state.units.find((row) => row.id === params.unitId);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Bilik tidak ditemukan.");
  assertFresh(current.updatedAt, body.expectedUpdatedAt);
  const changes = withoutStamp(body);
  if (changes.areaId !== undefined)
    requireArea(state, changes.areaId, current.facilityId);
  if (changes.code !== undefined)
    assertUnitCodeFree(
      state,
      current.facilityId,
      changes.code.trim(),
      current.id,
    );
  const next = validate(facilityUnitSchema, {
    ...current,
    ...changes,
    ...(changes.code !== undefined && { code: changes.code.trim() }),
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    units: state.units.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

// ---- Products and add-ons ---------------------------------------------------

registerMock(createFacilityProduct, ({ body }) => {
  const state = store.get();
  const replay = replayCreate("product", body, state.products);
  if (replay) return { data: replay };
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
    updatedAt: stamp(),
  });
  store.set({ ...state, products: [...state.products, product] });
  rememberCreate("product", body, product.id);
  return { data: product };
});

registerMock(updateFacilityProduct, ({ params, body }) => {
  const state = store.get();
  const current = state.products.find((row) => row.id === params.productId);
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Produk fasilitas tidak ditemukan.");
  assertFresh(current.updatedAt, body.expectedUpdatedAt);
  const next = validate(facilityProductSchema, {
    ...current,
    ...withoutStamp(body),
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    products: state.products.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

registerMock(createFacilityAddon, ({ body }) => {
  const state = store.get();
  const replay = replayCreate("addon", body, state.addons);
  if (replay) return { data: replay };
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
    updatedAt: stamp(),
  });
  store.set({ ...state, addons: [...state.addons, addon] });
  rememberCreate("addon", body, addon.id);
  return { data: addon };
});

registerMock(updateFacilityAddon, ({ params, body }) => {
  const state = store.get();
  const current = state.addons.find((row) => row.id === params.addonId);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Add-on tidak ditemukan.");
  assertFresh(current.updatedAt, body.expectedUpdatedAt);
  const next = validate(facilityAddonSchema, {
    ...current,
    ...withoutStamp(body),
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    addons: state.addons.map((row) => (row.id === next.id ? next : row)),
  });
  return { data: next };
});

// ---- Entitlement rules ------------------------------------------------------

// PUT upserts like the API: `expectedUpdatedAt: null` creates the rule under
// the path id, a stamp replaces exactly that version.
registerMock(putEntitlementRule, ({ params, body }) => {
  const state = store.get();
  const current = state.entitlementRules.find(
    (row) => row.id === params.ruleId,
  );
  assertFresh(current?.updatedAt ?? null, body.expectedUpdatedAt);
  const facility = requireFacility(state, body.facilityId);
  if (current && body.facilityId !== current.facilityId)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Aturan hak akses bukan milik fasilitas ini.",
      [{ field: "facilityId", message: "Fasilitas tidak cocok." }],
    );
  const next = validate(entitlementRuleSchema, {
    id: params.ruleId,
    tenantId: facility.tenantId,
    outletId: facility.outletId,
    ...withoutStamp(body),
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    entitlementRules: current
      ? state.entitlementRules.map((row) => (row.id === next.id ? next : row))
      : [...state.entitlementRules, next],
  });
  return { data: next };
});

// ---- Subscription plans -----------------------------------------------------

registerMock(createSubscriptionPlanEndpoint, ({ body }) => {
  const state = store.get();
  const replay = replayCreate("plan", body, state.subscriptionPlans);
  if (replay) return { data: replay };
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
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    subscriptionPlans: [...state.subscriptionPlans, plan],
  });
  rememberCreate("plan", body, plan.id);
  return { data: plan };
});

registerMock(updateSubscriptionPlan, ({ params, body }) => {
  const state = store.get();
  const current = state.subscriptionPlans.find(
    (row) => row.id === params.planId,
  );
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Paket langganan tidak ditemukan.");
  assertFresh(current.updatedAt, body.expectedUpdatedAt);
  const next = validate(subscriptionPlanSchema, {
    ...current,
    ...withoutStamp(body),
    updatedAt: stamp(),
  });
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
  assertFresh(current?.updatedAt ?? null, body.expectedUpdatedAt);
  // `facilityId` is optional in the PUT body but is not a policy column; the
  // zone and the outlet scope identify it (PRD §6 C floor_zones).
  if (!current && !body.facilityId)
    throw new ApiError(400, "VALIDATION_ERROR", "Fasilitas wajib diisi.", [
      {
        field: "facilityId",
        message: "Fasilitas wajib diisi untuk aturan baru.",
      },
    ]);
  const scope = current ?? requireFacility(state, body.facilityId as string);
  const next = validate(wifiPolicySchema, {
    id: params.policyId,
    tenantId: scope.tenantId,
    outletId: scope.outletId,
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
    updatedAt: stamp(),
  });
  store.set({
    ...state,
    wifiPolicies: current
      ? state.wifiPolicies.map((row) => (row.id === next.id ? next : row))
      : [...state.wifiPolicies, next],
  });
  return { data: next };
});
