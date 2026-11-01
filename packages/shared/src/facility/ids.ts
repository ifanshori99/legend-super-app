// Branded ids of the facility (WS-09) domain. Conventions:
// docs/plan/contracts.md D-CORE-1 — UUID for configuration aggregates, ULID
// for time-ordered operational rows. PRD v1.7 §6 K: `access_tickets.id` is a
// ULID primary key; every other table in the group uses UUID.
//
// Ids owned by other workstreams stay unbranded references (plain uuidSchema):
// customer profile (WS-08), menu item / tax rule (WS-03), inventory item
// (WS-06), floor zone (WS-03), devices (WS-02). Branding them here would mint a
// second id type for an aggregate another contract owns.

import { z, ulidIdSchema, uuidIdSchema } from "../core/index.ts";

export const facilityIdSchema = uuidIdSchema<"FacilityId">();
export const facilityAreaIdSchema = uuidIdSchema<"FacilityAreaId">();
export const facilityUnitIdSchema = uuidIdSchema<"FacilityUnitId">();
export const facilityProductIdSchema = uuidIdSchema<"FacilityProductId">();
export const facilityAddonIdSchema = uuidIdSchema<"FacilityAddonId">();
export const accessTicketIdSchema = ulidIdSchema<"AccessTicketId">();
export const facilityQueueEntryIdSchema =
  uuidIdSchema<"FacilityQueueEntryId">();
export const entitlementRuleIdSchema = uuidIdSchema<"EntitlementRuleId">();
export const entitlementLedgerIdSchema = uuidIdSchema<"EntitlementLedgerId">();
export const subscriptionPlanIdSchema = uuidIdSchema<"SubscriptionPlanId">();
export const facilitySubscriptionIdSchema =
  uuidIdSchema<"FacilitySubscriptionId">();
export const subscriptionInvoiceIdSchema =
  uuidIdSchema<"SubscriptionInvoiceId">();
export const lockCredentialIdSchema = uuidIdSchema<"LockCredentialId">();
export const accessEventIdSchema = ulidIdSchema<"AccessEventId">();
export const cleaningTaskIdSchema = uuidIdSchema<"CleaningTaskId">();
export const facilityIncidentIdSchema = uuidIdSchema<"FacilityIncidentId">();
export const facilityLinkedOrderIdSchema =
  uuidIdSchema<"FacilityLinkedOrderId">();
export const wifiPolicyIdSchema = uuidIdSchema<"WifiPolicyId">();
export const wifiSessionIdSchema = uuidIdSchema<"WifiSessionId">();

export type FacilityId = z.infer<typeof facilityIdSchema>;
export type FacilityAreaId = z.infer<typeof facilityAreaIdSchema>;
export type FacilityUnitId = z.infer<typeof facilityUnitIdSchema>;
export type FacilityProductId = z.infer<typeof facilityProductIdSchema>;
export type FacilityAddonId = z.infer<typeof facilityAddonIdSchema>;
export type AccessTicketId = z.infer<typeof accessTicketIdSchema>;
export type FacilityQueueEntryId = z.infer<typeof facilityQueueEntryIdSchema>;
export type EntitlementRuleId = z.infer<typeof entitlementRuleIdSchema>;
export type EntitlementLedgerId = z.infer<typeof entitlementLedgerIdSchema>;
export type SubscriptionPlanId = z.infer<typeof subscriptionPlanIdSchema>;
export type FacilitySubscriptionId = z.infer<
  typeof facilitySubscriptionIdSchema
>;
export type SubscriptionInvoiceId = z.infer<typeof subscriptionInvoiceIdSchema>;
export type LockCredentialId = z.infer<typeof lockCredentialIdSchema>;
export type AccessEventId = z.infer<typeof accessEventIdSchema>;
export type CleaningTaskId = z.infer<typeof cleaningTaskIdSchema>;
export type FacilityIncidentId = z.infer<typeof facilityIncidentIdSchema>;
export type FacilityLinkedOrderId = z.infer<typeof facilityLinkedOrderIdSchema>;
export type WifiPolicyId = z.infer<typeof wifiPolicyIdSchema>;
export type WifiSessionId = z.infer<typeof wifiSessionIdSchema>;
