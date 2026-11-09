// Guest-facing reads of the facility domain (PRD v1.7 §3 F22/F25, §25 Akses
// Fasilitas; beads legend-zjfi, legend-humf, legend-t3dl; FAC-11).
//
// - `getFacilityCatalog` and `resolveFacilityEntry` are public: the booking page
//   must open without a Wi-Fi or app login (FAC-11). They only expose what a
//   price board shows (name, hours, session length, active products with price,
//   add-ons, plans). No staff configuration: overtime and cancellation rules,
//   arrival tolerance, cleaning buffer, tax rule, lock/panic device ids,
//   inventory links, provider plan ids and entitlement rules never appear here.
// - `getCurrentEntitlements` is the signed-in customer's own balance. The
//   caller never names a customer; the server resolves the profile.
//
// There is no QR token column on facilities or units yet, so the entry token is
// the facility's public id (the same UUID the catalog and availability take).

import {
  z,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  timeZoneSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { entitlementBalanceSchema } from "./entitlement.ts";
import { entitlementLedgerIdSchema, facilityIdSchema } from "./ids.ts";
import {
  entitlementSourceSchema,
  facilityAddonSchema,
  facilityAreaSchema,
  facilityProductSchema,
  facilitySchema,
  subscriptionPlanSchema,
} from "./schemas.ts";

/** Facility fields a guest may see; the outlet time zone makes the hours readable. */
export const publicFacilitySchema = facilitySchema
  .pick({
    id: true,
    name: true,
    type: true,
    sessionMinutes: true,
    operatingHours: true,
  })
  .extend({ outletId: outletIdSchema, timeZone: timeZoneSchema });
export type PublicFacility = z.infer<typeof publicFacilitySchema>;

export const publicFacilityAreaSchema = facilityAreaSchema.pick({
  id: true,
  name: true,
  sortOrder: true,
});
export type PublicFacilityArea = z.infer<typeof publicFacilityAreaSchema>;

export const publicFacilityProductSchema = facilityProductSchema.pick({
  id: true,
  name: true,
  type: true,
  priceIdr: true,
  sessions: true,
  maxPerDay: true,
});
export type PublicFacilityProduct = z.infer<typeof publicFacilityProductSchema>;

export const publicFacilityAddonSchema = facilityAddonSchema.pick({
  id: true,
  name: true,
  priceIdr: true,
  sortOrder: true,
});
export type PublicFacilityAddon = z.infer<typeof publicFacilityAddonSchema>;

export const publicSubscriptionPlanSchema = subscriptionPlanSchema.pick({
  id: true,
  name: true,
  priceIdr: true,
  quotaPerPeriod: true,
  interval: true,
  maxPerDay: true,
});
export type PublicSubscriptionPlan = z.infer<
  typeof publicSubscriptionPlanSchema
>;

export const facilityCatalogSchema = z.strictObject({
  facility: publicFacilitySchema,
  /** Active products only, cheapest first. */
  products: z.array(publicFacilityProductSchema),
  /** Enabled add-ons only, in display order. */
  addons: z.array(publicFacilityAddonSchema),
  /** Active subscription plans only, cheapest first. */
  plans: z.array(publicSubscriptionPlanSchema),
});
export type FacilityCatalog = z.infer<typeof facilityCatalogSchema>;

export const facilityCatalogQuerySchema = z.strictObject({
  facilityId: facilityIdSchema,
});

export const facilityEntryParamsSchema = z.strictObject({
  /** The facility's public id until a dedicated QR token exists. */
  token: z.string().trim().min(1).max(100),
});

export const facilityEntrySchema = z.strictObject({
  facility: publicFacilitySchema,
  /** For the area choice (Area Pria / Area Wanita), in display order. */
  areas: z.array(publicFacilityAreaSchema),
});
export type FacilityEntry = z.infer<typeof facilityEntrySchema>;

export const facilityEntitlementsQuerySchema = z.strictObject({
  facilityId: facilityIdSchema,
});

/** One grant the customer can still draw sessions from. */
export const redeemableEntitlementGrantSchema = z.strictObject({
  id: entitlementLedgerIdSchema,
  source: entitlementSourceSchema,
  sessions: z.number().int().min(1).max(100),
  /** Null = never expires (staff grant). */
  expiresAt: isoDateTimeSchema.nullable(),
  grantedAt: isoDateTimeSchema,
});
export type RedeemableEntitlementGrant = z.infer<
  typeof redeemableEntitlementGrantSchema
>;

export const currentEntitlementsSchema = z.strictObject({
  balance: entitlementBalanceSchema,
  /** Grants not yet expired, soonest expiry first; never another customer's. */
  grants: z.array(redeemableEntitlementGrantSchema),
});
export type CurrentEntitlements = z.infer<typeof currentEntitlementsSchema>;

/** Public: no login (FAC-11). Unknown or foreign facility id answers 404. */
export const getFacilityCatalog = defineEndpoint({
  method: "GET",
  path: "/api/facility/catalog",
  query: facilityCatalogQuerySchema,
  response: dataResponseSchema(facilityCatalogSchema),
});

/** Public: resolves the door/table QR token to its facility. */
export const resolveFacilityEntry = defineEndpoint({
  method: "GET",
  path: "/api/facility/entry/:token",
  params: facilityEntryParamsSchema,
  response: dataResponseSchema(facilityEntrySchema),
});

/** Signed-in customer: own balance and redeemable grants at one facility. */
export const getCurrentEntitlements = defineEndpoint({
  method: "GET",
  path: "/api/facility/entitlements/current",
  query: facilityEntitlementsQuerySchema,
  response: dataResponseSchema(currentEntitlementsSchema),
});

export const facilityCustomerEndpoints = [
  getFacilityCatalog,
  resolveFacilityEntry,
  getCurrentEntitlements,
] as const;
