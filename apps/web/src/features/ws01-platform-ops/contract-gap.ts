// CONTRACT GAPS (bead legend-y6s). What @starter/shared/platform does not
// define yet, and how each screen degrades without faking success:
//
// 1. Cross-tenant audit list — the contract now lives in @starter/shared/platform
//    (platformEndpoints.listPlatformAuditEvents, permission platform.audit.view,
//    bead legend-bag1). The API has no route for it yet, so outside mock mode
//    /platform/audit says "not available yet" and sends no request
//    (PLATFORM_AUDIT_AVAILABLE).
// 2. Platform health / infrastructure metrics — GET /api/platform/health exists
//    (process and database only). /platform/kesehatan still shows tenant
//    statuses and quota/cap usage from listTenants + getTenantUsage, and an
//    explicit "belum tersedia" state for infra metrics.
// 3. Package definitions editor — only listPackages exists. /platform/paket
//    shows packages read-only; there is no create/edit/retire flow to save.
// 4. Feature flag rollout — flags are per tenant only (tenant.featureFlags:
//    modules + integrationProviders via setTenantPackage). There is no
//    percentage, cohort or per-outlet rollout, so the UI offers none.
// 5. setTenantPackage carries plan, flags and limits together; the screens send
//    the tenant's current values for the parts they do not edit.
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  listPlatformAuditEventsQuerySchema,
  platformEndpoints,
  type ListPlatformAuditEventsQuery,
} from "@starter/shared/platform";

export const listAuditEventsQuerySchema = listPlatformAuditEventsQuerySchema;
export type ListAuditEventsQuery = ListPlatformAuditEventsQuery;

export const listPlatformAuditEvents =
  platformEndpoints.listPlatformAuditEvents;

/** True only where something answers listPlatformAuditEvents (the mock). */
export const PLATFORM_AUDIT_AVAILABLE: boolean = API_MOCK;
