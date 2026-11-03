// CONTRACT GAPS (bead legend-y6s). What @starter/shared/platform does not
// define yet, and how each screen degrades without faking success:
//
// 1. Cross-tenant audit list — no endpoint (the tenant viewer
//    `/api/audit/events` is scoped to one tenant and `audit.log.view`). The
//    local endpoint below reuses auditEventSchema so screen and mock are typed;
//    a follow-up contract bead should move it into the platform package (and
//    decide a dedicated permission). Outside mock mode the API has no such
//    route, so /platform/audit says "not available yet" and sends no request
//    (PLATFORM_AUDIT_AVAILABLE).
// 2. Platform health / infrastructure metrics — no endpoint. /platform/kesehatan
//    shows only tenant statuses and quota/cap usage from listTenants +
//    getTenantUsage, and an explicit "belum tersedia" state for infra.
// 3. Package definitions editor — only listPackages exists. /platform/paket
//    shows packages read-only; there is no create/edit/retire flow to save.
// 4. Feature flag rollout — flags are per tenant only (tenant.featureFlags:
//    modules + integrationProviders via setTenantPackage). There is no
//    percentage, cohort or per-outlet rollout, so the UI offers none.
// 5. setTenantPackage carries plan, flags and limits together; the screens send
//    the tenant's current values for the parts they do not edit.
import { API_MOCK } from "@/lib/api/mock-flag";
import { defineEndpoint } from "@starter/shared/api";
import { auditActorTypeSchema, auditEventSchema } from "@starter/shared/audit";
import {
  cursorPageQuerySchema,
  cursorPageSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  z,
} from "@starter/shared/core";

export const listAuditEventsQuerySchema = cursorPageQuerySchema.extend({
  tenantId: tenantIdSchema.optional(),
  actorType: auditActorTypeSchema.optional(),
  /** Matches the action name or the start of it, e.g. `tenant.` or `role.updated`. */
  action: z.string().trim().max(150).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;

export const listPlatformAuditEvents = defineEndpoint({
  method: "GET",
  path: "/api/platform/audit-events",
  query: listAuditEventsQuerySchema,
  response: cursorPageSchema(auditEventSchema),
});

/** True only where something answers listPlatformAuditEvents (the mock). */
export const PLATFORM_AUDIT_AVAILABLE: boolean = API_MOCK;
