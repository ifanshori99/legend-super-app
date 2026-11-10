// Typed callers for the facility admin endpoints (bead legend-er32; PRD v1.7
// §3 F25). Components never call these directly: hooks.ts owns the cache.
// Every request goes through the shared contract object, so mock mode and the
// future API validate the same shapes (docs/frontend.md "Typed endpoints and
// mock mode").
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createFacilityAddon,
  createFacilityArea,
  createFacilityProduct,
  createFacilityUnit,
  createSubscriptionPlanEndpoint,
  getFacilityConfig,
  listFacilities,
  putEntitlementRule,
  putWifiPolicy as putWifiPolicyEndpoint,
  updateFacility as updateFacilityEndpoint,
  updateFacilityAddon,
  updateFacilityArea,
  updateFacilityProduct,
  updateFacilityUnitConfig,
  updateSubscriptionPlan,
} from "@starter/shared/facility";
import { listInventoryItems } from "@starter/shared/inventory";
import { listItems as listMenuItems } from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint.ts";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// Bodies as the screens build them: the optimistic-lock stamp
// (`expectedUpdatedAt`) and the create key (`idempotencyKey`) are added here
// by hooks.ts, never by a form (bead legend-6jms).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Draft<E extends AnyEndpoint> = DistributiveOmit<
  Body<E>,
  "expectedUpdatedAt" | "idempotencyKey"
>;

export type UpdateFacilityBody = Draft<typeof updateFacilityEndpoint>;
export type CreateAreaBody = Draft<typeof createFacilityArea>;
export type UpdateAreaBody = Draft<typeof updateFacilityArea>;
export type CreateUnitBody = Draft<typeof createFacilityUnit>;
export type UpdateUnitConfigBody = Draft<typeof updateFacilityUnitConfig>;
export type CreateProductBody = Draft<typeof createFacilityProduct>;
export type UpdateProductBody = Draft<typeof updateFacilityProduct>;
export type CreateAddonBody = Draft<typeof createFacilityAddon>;
export type UpdateAddonBody = Draft<typeof updateFacilityAddon>;
export type PutEntitlementRuleBody = Draft<typeof putEntitlementRule>;
export type CreatePlanBody = Draft<typeof createSubscriptionPlanEndpoint>;
export type UpdatePlanBody = Draft<typeof updateSubscriptionPlan>;
export type PutWifiPolicyBody = Draft<typeof putWifiPolicyEndpoint>;
export type FacilitiesQuery = Query<typeof listFacilities>;

// ---- Reads ---------------------------------------------------------------

export function fetchFacilities(query: FacilitiesQuery, signal?: AbortSignal) {
  return callEndpoint(listFacilities, { query }, { signal });
}

export async function fetchFacilityConfig(
  facilityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getFacilityConfig,
    { query: { facilityId } },
    { signal },
  );
  return response.data;
}

/** Menu packages available to link to a facility product or rule (WS-03). */
export async function fetchMenuItems(signal?: AbortSignal) {
  const response = await callEndpoint(
    listMenuItems,
    { query: { limit: 100 } },
    { signal },
  );
  return response.data;
}

/** Inventory items an add-on may consume (WS-06). */
export async function fetchInventoryItems(signal?: AbortSignal) {
  const response = await callEndpoint(
    listInventoryItems,
    { query: { limit: 100 } },
    { signal },
  );
  return response.data;
}

// ---- Facility, areas and units ------------------------------------------

/** `expectedUpdatedAt`: the row's `updatedAt` the editor last read (409 if stale). */
export async function updateFacility(
  facilityId: string,
  body: UpdateFacilityBody,
  expectedUpdatedAt: string,
) {
  const response = await callEndpoint(updateFacilityEndpoint, {
    params: { facilityId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

/** `idempotencyKey`: one per create attempt; a replay returns the first row. */
export async function createArea(body: CreateAreaBody, idempotencyKey: string) {
  const response = await callEndpoint(createFacilityArea, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function updateArea(
  areaId: string,
  body: UpdateAreaBody,
  expectedUpdatedAt: string,
) {
  const response = await callEndpoint(updateFacilityArea, {
    params: { areaId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

export async function createUnit(body: CreateUnitBody, idempotencyKey: string) {
  const response = await callEndpoint(createFacilityUnit, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function updateUnitConfig(
  unitId: string,
  body: UpdateUnitConfigBody,
  expectedUpdatedAt: string,
) {
  const response = await callEndpoint(updateFacilityUnitConfig, {
    params: { unitId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

// ---- Products, add-ons, rules -------------------------------------------

export async function createProduct(
  body: CreateProductBody,
  idempotencyKey: string,
) {
  const response = await callEndpoint(createFacilityProduct, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function updateProduct(
  productId: string,
  body: UpdateProductBody,
  expectedUpdatedAt: string,
) {
  const response = await callEndpoint(updateFacilityProduct, {
    params: { productId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

export async function createAddon(
  body: CreateAddonBody,
  idempotencyKey: string,
) {
  const response = await callEndpoint(createFacilityAddon, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function updateAddon(
  addonId: string,
  body: UpdateAddonBody,
  expectedUpdatedAt: string,
) {
  const response = await callEndpoint(updateFacilityAddon, {
    params: { addonId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

/**
 * PUT replaces the whole rule: the condition is required and fixed per type.
 * `expectedUpdatedAt` is null only when the rule does not exist yet.
 */
export async function putRule(
  ruleId: string,
  body: PutEntitlementRuleBody,
  expectedUpdatedAt: string | null,
) {
  const response = await callEndpoint(putEntitlementRule, {
    params: { ruleId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

// ---- Subscriptions and Wi-Fi --------------------------------------------

export async function createPlan(body: CreatePlanBody, idempotencyKey: string) {
  const response = await callEndpoint(createSubscriptionPlanEndpoint, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function updatePlan(
  planId: string,
  body: UpdatePlanBody,
  expectedUpdatedAt: string,
) {
  const response = await callEndpoint(updateSubscriptionPlan, {
    params: { planId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}

/**
 * PUT replaces the zone policy; it applies on the next request (FAC-14).
 * `expectedUpdatedAt` is null only when the policy does not exist yet.
 */
export async function putWifiPolicy(
  policyId: string,
  body: PutWifiPolicyBody,
  expectedUpdatedAt: string | null,
) {
  const response = await callEndpoint(putWifiPolicyEndpoint, {
    params: { policyId },
    body: { ...body, expectedUpdatedAt },
  });
  return response.data;
}
