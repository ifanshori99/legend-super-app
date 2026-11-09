// HTTP contracts for the Panel Platform and tenant organisation settings
// (PRD v1.7 §3 F4, flow R). The API validates with these objects; the web
// app's typed client and mock runtime read the same ones.
//
// - `/api/platform/...` = Super Admin (platform permissions, MFA). The target
//   tenant is a path parameter chosen by a platform user; it is never the
//   caller's tenant context and never sent in a body.
// - `/api/org/...` = tenant admin. The tenant comes from the domain/session
//   (TEN-02); bodies are clientInputSchema objects without tenantId.

import {
  brandIdSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  outletIdSchema,
  tenantIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { COLOR_TOKENS } from "../theme/types.ts";
import { DERIVED_TOKENS } from "../theme/contrast.ts";
import {
  configBundleSchema,
  configImportSchema,
  configTemplateSummarySchema,
  createConfigTemplateInputSchema,
  importConfigInputSchema,
} from "./config.ts";
import { brandContextSchema } from "./context.ts";
import { addDomainInputSchema, tenantDomainSchema } from "./domains.ts";
import {
  legalEntityIdSchema,
  supportAccessGrantIdSchema,
  supportAccessRequestIdSchema,
  tenantDomainIdSchema,
  tenantIntegrationIdSchema,
  tenantThemeIdSchema,
} from "./ids.ts";
import {
  setIntegrationStatusInputSchema,
  tenantIntegrationSchema,
  upsertIntegrationInputSchema,
} from "./integrations.ts";
import {
  costCapSchema,
  costCapStateSchema,
  countQuotaSchema,
  tenantLimitsSchema,
  tenantUsageSchema,
} from "./limits.ts";
import { featureFlagsSchema, platformPackageSchema } from "./modules.ts";
import {
  brandSchema,
  createBrandInputSchema,
  createLegalEntityInputSchema,
  createOutletInputSchema,
  createTenantInputSchema,
  legalEntitySchema,
  outletSchema,
  setOutletStatusInputSchema,
  setTenantPackageInputSchema,
  setTenantStatusInputSchema,
  tenantSchema,
  tenantStatusSchema,
  updateBrandInputSchema,
  updateLegalEntityInputSchema,
  updateOutletInputSchema,
} from "./org.ts";
import {
  assignTenantOwnerInputSchema,
  replaceTenantOwnerInputSchema,
  tenantOwnerAssignmentIdSchema,
  tenantOwnerAssignmentSchema,
} from "./tenant-owner.ts";
import {
  decideSupportAccessRequestInputSchema,
  requestSupportAccessInputSchema,
  requestSupportWriteAccessInputSchema,
  supportAccessGrantSchema,
  supportAccessRequestSchema,
} from "./support-access.ts";
import {
  createThemeDraftInputSchema,
  tenantThemeSchema,
  themeTokensSchema,
} from "./themes.ts";

const tenantParams = z.strictObject({ tenantId: tenantIdSchema });
// Contrast failures may name derived tokens (e.g. primary-hover) too.
const themeToken = z.enum([
  ...COLOR_TOKENS,
  ...(Object.keys(DERIVED_TOKENS) as [keyof typeof DERIVED_TOKENS]),
]);

/** Usage dashboard row: quotas + cost caps, computed server-side. */
export const tenantUsageViewSchema = z.strictObject({
  usage: tenantUsageSchema,
  limits: tenantLimitsSchema,
  quotas: z.array(
    z.strictObject({
      quota: countQuotaSchema,
      limit: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
    }),
  ),
  costCaps: z.array(
    z.strictObject({
      cap: costCapSchema,
      state: costCapStateSchema,
      capIdr: z.number().int().nonnegative(),
      spentIdr: z.number().int().nonnegative(),
      remainingIdr: z.number().int().nonnegative(),
    }),
  ),
});
export type TenantUsageView = z.infer<typeof tenantUsageViewSchema>;

/** Contrast preview for the theme editor (TEN-10). */
export const themeCheckResultSchema = z.strictObject({
  ok: z.boolean(),
  failures: z.array(
    z.strictObject({
      mode: z.enum(["light", "dark"]),
      fg: themeToken,
      bg: themeToken,
      ratio: z.number().positive(),
      min: z.number().positive(),
      use: z.string(),
    }),
  ),
  invalid: z.array(z.string()),
});

export const listTenantsQuerySchema = cursorPageQuerySchema.extend({
  status: tenantStatusSchema.optional(),
  q: z.string().trim().max(80).optional(),
});

// ------------------------------------------------------------ Panel Platform

export const platformEndpoints = {
  listPackages: defineEndpoint({
    method: "GET",
    path: "/api/platform/packages",
    response: z.object({ data: z.array(platformPackageSchema) }),
  }),
  listTenants: defineEndpoint({
    method: "GET",
    path: "/api/platform/tenants",
    query: listTenantsQuerySchema,
    response: cursorPageSchema(tenantSchema),
  }),
  createTenant: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants",
    body: createTenantInputSchema,
    response: dataResponseSchema(tenantSchema),
  }),
  getTenant: defineEndpoint({
    method: "GET",
    path: "/api/platform/tenants/:tenantId",
    params: tenantParams,
    response: dataResponseSchema(tenantSchema),
  }),
  setTenantStatus: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/status",
    params: tenantParams,
    body: setTenantStatusInputSchema,
    response: dataResponseSchema(tenantSchema),
  }),
  setTenantPackage: defineEndpoint({
    method: "PUT",
    path: "/api/platform/tenants/:tenantId/package",
    params: tenantParams,
    body: setTenantPackageInputSchema,
    response: dataResponseSchema(tenantSchema),
  }),
  getTenantUsage: defineEndpoint({
    method: "GET",
    path: "/api/platform/tenants/:tenantId/usage",
    params: tenantParams,
    response: dataResponseSchema(tenantUsageViewSchema),
  }),
  requestSupportAccess: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/support-access",
    params: tenantParams,
    body: requestSupportAccessInputSchema,
    response: dataResponseSchema(supportAccessGrantSchema),
  }),
  requestSupportWriteAccess: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/support-access-requests",
    params: tenantParams,
    body: requestSupportWriteAccessInputSchema,
    response: dataResponseSchema(supportAccessRequestSchema),
  }),
  assignTenantOwner: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/owners",
    params: tenantParams,
    body: assignTenantOwnerInputSchema,
    response: dataResponseSchema(tenantOwnerAssignmentSchema),
  }),
  replaceTenantOwner: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/owners/:assignmentId/replace",
    params: z.strictObject({
      tenantId: tenantIdSchema,
      assignmentId: tenantOwnerAssignmentIdSchema,
    }),
    body: replaceTenantOwnerInputSchema,
    response: dataResponseSchema(tenantOwnerAssignmentSchema),
  }),
  listSupportAccess: defineEndpoint({
    method: "GET",
    path: "/api/platform/support-access",
    query: cursorPageQuerySchema.extend({
      tenantId: tenantIdSchema.optional(),
    }),
    response: cursorPageSchema(supportAccessGrantSchema),
  }),
  endSupportAccess: defineEndpoint({
    method: "POST",
    path: "/api/platform/support-access/:grantId/end",
    params: z.strictObject({ grantId: supportAccessGrantIdSchema }),
    response: dataResponseSchema(supportAccessGrantSchema),
  }),
  listConfigTemplates: defineEndpoint({
    method: "GET",
    path: "/api/platform/config-templates",
    query: cursorPageQuerySchema,
    response: cursorPageSchema(configTemplateSummarySchema),
  }),
  createConfigTemplate: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/config-templates",
    params: tenantParams,
    body: createConfigTemplateInputSchema,
    response: dataResponseSchema(configTemplateSummarySchema),
  }),
  importConfig: defineEndpoint({
    method: "POST",
    path: "/api/platform/tenants/:tenantId/config-import",
    params: tenantParams,
    body: importConfigInputSchema,
    response: dataResponseSchema(configImportSchema),
  }),
} as const;

// -------------------------------------------------------------- tenant org

const brandParams = z.strictObject({ brandId: brandIdSchema });
const outletParams = z.strictObject({ outletId: outletIdSchema });
const legalEntityParams = z.strictObject({
  legalEntityId: legalEntityIdSchema,
});

// ------------------------------------------------- whitelabel brand context

/**
 * Whitelabel brand of the host the request was sent to (PRD v1.7 §3 F4
 * "Whitelabel", D43, TEN-08). Public: the web server calls it during SSR, the
 * browser reads the same DTO. No tenant parameter: the host is the input
 * (TEN-02), and the answer carries no platform identity (TEN-08).
 */
export const getBrandContext = defineEndpoint({
  method: "GET",
  path: "/api/tenant/context",
  response: dataResponseSchema(brandContextSchema),
});

export const orgEndpoints = {
  getModules: defineEndpoint({
    method: "GET",
    path: "/api/org/modules",
    response: dataResponseSchema(featureFlagsSchema),
  }),
  getUsage: defineEndpoint({
    method: "GET",
    path: "/api/org/usage",
    response: dataResponseSchema(tenantUsageViewSchema),
  }),
  listBrands: defineEndpoint({
    method: "GET",
    path: "/api/org/brands",
    response: z.object({ data: z.array(brandSchema) }),
  }),
  createBrand: defineEndpoint({
    method: "POST",
    path: "/api/org/brands",
    body: createBrandInputSchema,
    response: dataResponseSchema(brandSchema),
  }),
  updateBrand: defineEndpoint({
    method: "PATCH",
    path: "/api/org/brands/:brandId",
    params: brandParams,
    body: updateBrandInputSchema,
    response: dataResponseSchema(brandSchema),
  }),
  listOutlets: defineEndpoint({
    method: "GET",
    path: "/api/org/outlets",
    query: cursorPageQuerySchema.extend({ brandId: brandIdSchema.optional() }),
    response: cursorPageSchema(outletSchema),
  }),
  createOutlet: defineEndpoint({
    method: "POST",
    path: "/api/org/outlets",
    body: createOutletInputSchema,
    response: dataResponseSchema(outletSchema),
  }),
  updateOutlet: defineEndpoint({
    method: "PATCH",
    path: "/api/org/outlets/:outletId",
    params: outletParams,
    body: updateOutletInputSchema,
    response: dataResponseSchema(outletSchema),
  }),
  setOutletStatus: defineEndpoint({
    method: "POST",
    path: "/api/org/outlets/:outletId/status",
    params: outletParams,
    body: setOutletStatusInputSchema,
    response: dataResponseSchema(outletSchema),
  }),
  listLegalEntities: defineEndpoint({
    method: "GET",
    path: "/api/org/legal-entities",
    response: z.object({ data: z.array(legalEntitySchema) }),
  }),
  createLegalEntity: defineEndpoint({
    method: "POST",
    path: "/api/org/legal-entities",
    body: createLegalEntityInputSchema,
    response: dataResponseSchema(legalEntitySchema),
  }),
  updateLegalEntity: defineEndpoint({
    method: "PATCH",
    path: "/api/org/legal-entities/:legalEntityId",
    params: legalEntityParams,
    body: updateLegalEntityInputSchema,
    response: dataResponseSchema(legalEntitySchema),
  }),
  listDomains: defineEndpoint({
    method: "GET",
    path: "/api/org/domains",
    response: z.object({ data: z.array(tenantDomainSchema) }),
  }),
  addDomain: defineEndpoint({
    method: "POST",
    path: "/api/org/domains",
    body: addDomainInputSchema,
    response: dataResponseSchema(tenantDomainSchema),
  }),
  removeDomain: defineEndpoint({
    method: "DELETE",
    path: "/api/org/domains/:domainId",
    params: z.strictObject({ domainId: tenantDomainIdSchema }),
  }),
  listIntegrations: defineEndpoint({
    method: "GET",
    path: "/api/org/integrations",
    response: z.object({ data: z.array(tenantIntegrationSchema) }),
  }),
  upsertIntegration: defineEndpoint({
    method: "PUT",
    path: "/api/org/integrations",
    body: upsertIntegrationInputSchema,
    response: dataResponseSchema(tenantIntegrationSchema),
  }),
  setIntegrationStatus: defineEndpoint({
    method: "POST",
    path: "/api/org/integrations/:integrationId/status",
    params: z.strictObject({ integrationId: tenantIntegrationIdSchema }),
    body: setIntegrationStatusInputSchema,
    response: dataResponseSchema(tenantIntegrationSchema),
  }),
  listThemes: defineEndpoint({
    method: "GET",
    path: "/api/org/themes",
    query: z.strictObject({ brandId: brandIdSchema }),
    response: z.object({ data: z.array(tenantThemeSchema) }),
  }),
  checkTheme: defineEndpoint({
    method: "POST",
    path: "/api/org/themes/check",
    body: z.strictObject({ tokens: themeTokensSchema }),
    response: dataResponseSchema(themeCheckResultSchema),
  }),
  createThemeDraft: defineEndpoint({
    method: "POST",
    path: "/api/org/themes",
    body: createThemeDraftInputSchema,
    response: dataResponseSchema(tenantThemeSchema),
  }),
  activateTheme: defineEndpoint({
    method: "POST",
    path: "/api/org/themes/:themeId/activate",
    params: z.strictObject({ themeId: tenantThemeIdSchema }),
    response: dataResponseSchema(tenantThemeSchema),
  }),
  listSupportAccess: defineEndpoint({
    method: "GET",
    path: "/api/org/support-access",
    query: cursorPageQuerySchema,
    response: cursorPageSchema(supportAccessGrantSchema),
  }),
  listSupportAccessRequests: defineEndpoint({
    method: "GET",
    path: "/api/org/support-access/requests",
    query: cursorPageQuerySchema,
    response: cursorPageSchema(supportAccessRequestSchema),
  }),
  approveSupportAccessRequest: defineEndpoint({
    method: "POST",
    path: "/api/org/support-access/requests/:requestId/approve",
    params: z.strictObject({ requestId: supportAccessRequestIdSchema }),
    body: decideSupportAccessRequestInputSchema,
    response: dataResponseSchema(supportAccessRequestSchema),
  }),
  rejectSupportAccessRequest: defineEndpoint({
    method: "POST",
    path: "/api/org/support-access/requests/:requestId/reject",
    params: z.strictObject({ requestId: supportAccessRequestIdSchema }),
    body: decideSupportAccessRequestInputSchema,
    response: dataResponseSchema(supportAccessRequestSchema),
  }),
  exportConfig: defineEndpoint({
    method: "POST",
    path: "/api/org/config/export",
    body: createConfigTemplateInputSchema.pick({ sections: true }),
    response: dataResponseSchema(configBundleSchema),
  }),
} as const;
