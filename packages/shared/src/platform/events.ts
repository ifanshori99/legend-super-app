// Platform & organisation events (WS-01, catalogued in events/catalog.ts).
// Naming `<aggregate>.<past_verb>`; ids are ULIDs in the shared envelope.
// Payloads carry no secrets, no NPWP, no credential values (integration
// events name the changed fields only).
//
// - `support_access.requested` asks the tenant owner to approve a read_write
//   session (legend-c9kbk); `support_access.granted` drives the tenant-admin notification and the
//   audit row (TEN-04); `support_access.ended` closes it (expiry or early end).
// - `usage_limit.reached` is the R18 alert at 80% and the stop at 100%.
// - `tenant.status_changed` lets consumers stop serving a suspended tenant
//   (the worker registry view drops it on its own, see ACTIVE_TENANT_REGISTRY).

import {
  brandIdSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import type { DomainEventDefinition } from "../events/define.ts";
import {
  configImportIdSchema,
  configTemplateIdSchema,
  legalEntityIdSchema,
  supportAccessGrantIdSchema,
  supportAccessRequestIdSchema,
  tenantDomainIdSchema,
  tenantIntegrationIdSchema,
  tenantThemeIdSchema,
} from "./ids.ts";
import { costCapSchema, countQuotaSchema } from "./limits.ts";
import { moduleKeySchema, packageKeySchema } from "./modules.ts";
import { configSectionSchema } from "./config.ts";
import {
  integrationProviderSchema,
  integrationStatusSchema,
} from "./integrations.ts";
import { outletStatusSchema, tenantStatusSchema } from "./org.ts";
import { supportAccessModeSchema } from "./support-access.ts";

const reason = z.string().min(1).max(500);
const changedFields = z.array(z.string().min(1).max(64)).min(1);

export const PLATFORM_EVENT_PAYLOADS = {
  "tenant.created": z.strictObject({
    slug: z.string(),
    plan: packageKeySchema,
    modules: z.array(moduleKeySchema),
    firstAdminUserId: userIdSchema,
  }),
  "tenant.status_changed": z.strictObject({
    from: tenantStatusSchema,
    to: tenantStatusSchema,
    reason,
  }),
  "tenant.package_changed": z.strictObject({
    plan: packageKeySchema,
    modulesEnabled: z.array(moduleKeySchema),
    modulesDisabled: z.array(moduleKeySchema),
    limitsChanged: z.array(z.string()),
    reason,
  }),
  "brand.created": z.strictObject({ brandId: brandIdSchema, slug: z.string() }),
  "brand.updated": z.strictObject({ brandId: brandIdSchema, changedFields }),
  "outlet.created": z.strictObject({
    outletId: outletIdSchema,
    brandId: brandIdSchema,
    legalEntityId: legalEntityIdSchema,
    code: z.string(),
  }),
  "outlet.updated": z.strictObject({ outletId: outletIdSchema, changedFields }),
  "outlet.status_changed": z.strictObject({
    outletId: outletIdSchema,
    from: outletStatusSchema,
    to: outletStatusSchema,
    reason,
  }),
  "legal_entity.created": z.strictObject({
    legalEntityId: legalEntityIdSchema,
    isPkp: z.boolean(),
  }),
  "legal_entity.updated": z.strictObject({
    legalEntityId: legalEntityIdSchema,
    changedFields,
  }),
  "tenant_domain.added": z.strictObject({
    domainId: tenantDomainIdSchema,
    brandId: brandIdSchema,
    hostname: z.string(),
    kind: z.enum(["platform_subdomain", "custom"]),
  }),
  "tenant_domain.verified": z.strictObject({
    domainId: tenantDomainIdSchema,
    hostname: z.string(),
    verifiedAt: isoDateTimeSchema,
  }),
  "tenant_domain.removed": z.strictObject({
    domainId: tenantDomainIdSchema,
    hostname: z.string(),
  }),
  "tenant_integration.updated": z.strictObject({
    integrationId: tenantIntegrationIdSchema,
    provider: integrationProviderSchema,
    outletId: outletIdSchema.nullable(),
    configKeysChanged: z.array(z.string()),
    /** True when credentials were replaced; values are never in the event. */
    credentialsReplaced: z.boolean(),
  }),
  "tenant_integration.status_changed": z.strictObject({
    integrationId: tenantIntegrationIdSchema,
    provider: integrationProviderSchema,
    from: integrationStatusSchema,
    to: integrationStatusSchema,
  }),
  "tenant_theme.activated": z.strictObject({
    themeId: tenantThemeIdSchema,
    brandId: brandIdSchema,
    version: z.number().int().positive(),
    previousThemeId: tenantThemeIdSchema.nullable(),
  }),
  "support_access.requested": z.strictObject({
    requestId: supportAccessRequestIdSchema,
    superAdminUserId: userIdSchema,
    reason,
    durationMinutes: z.union([z.literal(15), z.literal(30)]),
    approvalExpiresAt: isoDateTimeSchema,
  }),
  "support_access.granted": z.strictObject({
    grantId: supportAccessGrantIdSchema,
    superAdminUserId: userIdSchema,
    reason,
    accessMode: supportAccessModeSchema,
    startedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  }),
  "support_access.ended": z.strictObject({
    grantId: supportAccessGrantIdSchema,
    endedAt: isoDateTimeSchema,
    cause: z.enum([
      "expired",
      "ended_by_super_admin",
      "revoked_by_tenant_admin",
    ]),
  }),
  "config_import.completed": z.strictObject({
    importId: configImportIdSchema,
    templateId: configTemplateIdSchema.nullable(),
    appliedSections: z.array(configSectionSchema),
  }),
  "usage_limit.reached": z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("cost_cap"),
      cap: costCapSchema,
      state: z.enum(["warning", "stopped"]),
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      capIdr: z.number().int().nonnegative(),
      spentIdr: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("count_quota"),
      quota: countQuotaSchema,
      limit: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
    }),
  ]),
} as const;
export type PlatformEventType = keyof typeof PLATFORM_EVENT_PAYLOADS;
export const PLATFORM_EVENT_TYPES = Object.keys(
  PLATFORM_EVENT_PAYLOADS,
) as PlatformEventType[];

function definePlatformEvents(): Record<
  PlatformEventType,
  DomainEventDefinition
> {
  const definitions: Partial<Record<PlatformEventType, DomainEventDefinition>> =
    {};
  for (const name of PLATFORM_EVENT_TYPES) {
    const payload: z.ZodType<Record<string, unknown>> =
      PLATFORM_EVENT_PAYLOADS[name];
    definitions[name] = defineDomainEvent({ name, payload });
  }
  return definitions as Record<PlatformEventType, DomainEventDefinition>;
}

/** Catalog-bound definitions (throws at load for an uncatalogued name). */
export const platformEvents: Readonly<
  Record<PlatformEventType, DomainEventDefinition>
> = Object.freeze(definePlatformEvents());

export const platformEventCatalog = PLATFORM_EVENT_TYPES.map(
  (name) => platformEvents[name].entry,
);
