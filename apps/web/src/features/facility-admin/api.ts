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
  updateSubscriptionPlan,
} from "@starter/shared/facility";
import { listInventoryItems } from "@starter/shared/inventory";
import { listItems as listMenuItems } from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint.ts";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export type UpdateFacilityBody = Body<typeof updateFacilityEndpoint>;
export type CreateAreaBody = Body<typeof createFacilityArea>;
export type UpdateAreaBody = Body<typeof updateFacilityArea>;
export type CreateUnitBody = Body<typeof createFacilityUnit>;
export type CreateProductBody = Body<typeof createFacilityProduct>;
export type UpdateProductBody = Body<typeof updateFacilityProduct>;
export type CreateAddonBody = Body<typeof createFacilityAddon>;
export type UpdateAddonBody = Body<typeof updateFacilityAddon>;
export type PutEntitlementRuleBody = Body<typeof putEntitlementRule>;
export type CreatePlanBody = Body<typeof createSubscriptionPlanEndpoint>;
export type UpdatePlanBody = Body<typeof updateSubscriptionPlan>;
export type PutWifiPolicyBody = Body<typeof putWifiPolicyEndpoint>;
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

export async function updateFacility(
  facilityId: string,
  body: UpdateFacilityBody,
) {
  const response = await callEndpoint(updateFacilityEndpoint, {
    params: { facilityId },
    body,
  });
  return response.data;
}

export async function createArea(body: CreateAreaBody) {
  const response = await callEndpoint(createFacilityArea, { body });
  return response.data;
}

export async function updateArea(areaId: string, body: UpdateAreaBody) {
  const response = await callEndpoint(updateFacilityArea, {
    params: { areaId },
    body,
  });
  return response.data;
}

export async function createUnit(body: CreateUnitBody) {
  const response = await callEndpoint(createFacilityUnit, { body });
  return response.data;
}

// ---- Products, add-ons, rules -------------------------------------------

export async function createProduct(body: CreateProductBody) {
  const response = await callEndpoint(createFacilityProduct, { body });
  return response.data;
}

export async function updateProduct(
  productId: string,
  body: UpdateProductBody,
) {
  const response = await callEndpoint(updateFacilityProduct, {
    params: { productId },
    body,
  });
  return response.data;
}

export async function createAddon(body: CreateAddonBody) {
  const response = await callEndpoint(createFacilityAddon, { body });
  return response.data;
}

export async function updateAddon(addonId: string, body: UpdateAddonBody) {
  const response = await callEndpoint(updateFacilityAddon, {
    params: { addonId },
    body,
  });
  return response.data;
}

/** PUT replaces the whole rule: the condition is required and fixed per type. */
export async function putRule(ruleId: string, body: PutEntitlementRuleBody) {
  const response = await callEndpoint(putEntitlementRule, {
    params: { ruleId },
    body,
  });
  return response.data;
}

// ---- Subscriptions and Wi-Fi --------------------------------------------

export async function createPlan(body: CreatePlanBody) {
  const response = await callEndpoint(createSubscriptionPlanEndpoint, {
    body,
  });
  return response.data;
}

export async function updatePlan(planId: string, body: UpdatePlanBody) {
  const response = await callEndpoint(updateSubscriptionPlan, {
    params: { planId },
    body,
  });
  return response.data;
}

/** PUT replaces the zone policy; it applies on the next request (FAC-14). */
export async function putWifiPolicy(policyId: string, body: PutWifiPolicyBody) {
  const response = await callEndpoint(putWifiPolicyEndpoint, {
    params: { policyId },
    body,
  });
  return response.data;
}
