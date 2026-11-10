// Ids owned by the platform contract (PRD v1.7 §6 A Platform & Organisasi).
// Tenant, brand, outlet and user ids are core (`core/ids.ts`). The legal
// entity id is declared by the accounting contract because every ledger row is
// keyed by it; it is re-exported here (one runtime schema, one brand) so
// `legal_entities` and accounting share the exact same type.

import { uuidIdSchema } from "../core/index.ts";
import type { z } from "zod";

export { legalEntityIdSchema, type LegalEntityId } from "../accounting/ids.ts";

export const tenantDomainIdSchema = uuidIdSchema<"TenantDomainId">();
export const tenantIntegrationIdSchema = uuidIdSchema<"TenantIntegrationId">();
export const tenantThemeIdSchema = uuidIdSchema<"TenantThemeId">();
export const configTemplateIdSchema = uuidIdSchema<"ConfigTemplateId">();
export const configImportIdSchema = uuidIdSchema<"ConfigImportId">();
export const supportAccessGrantIdSchema =
  uuidIdSchema<"SupportAccessGrantId">();
export const supportAccessRequestIdSchema =
  uuidIdSchema<"SupportAccessRequestId">();
export const platformAdminIdSchema = uuidIdSchema<"PlatformAdminId">();
export const regionIdSchema = uuidIdSchema<"RegionId">();

export type TenantDomainId = z.infer<typeof tenantDomainIdSchema>;
export type TenantIntegrationId = z.infer<typeof tenantIntegrationIdSchema>;
export type TenantThemeId = z.infer<typeof tenantThemeIdSchema>;
export type ConfigTemplateId = z.infer<typeof configTemplateIdSchema>;
export type ConfigImportId = z.infer<typeof configImportIdSchema>;
export type SupportAccessGrantId = z.infer<typeof supportAccessGrantIdSchema>;
export type SupportAccessRequestId = z.infer<
  typeof supportAccessRequestIdSchema
>;
export type PlatformAdminId = z.infer<typeof platformAdminIdSchema>;
export type RegionId = z.infer<typeof regionIdSchema>;
