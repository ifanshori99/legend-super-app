// @starter/shared/core/server — SERVER-ONLY constructors for the values that
// grant tenant and outlet access. Import it only from apps/api (middleware,
// job runner, webhook handlers) and the edge runtime, never from browser code.
// It refuses to load where a DOM exists, so a client bundle that imports it
// fails at once instead of shipping a way to mint access.
//
// Callers pass values they resolved themselves on the server: the tenant from
// tenant_domains / a verified token / a job row / the receiving webhook
// account, and the outlet reach from the caller's verified role assignments
// (RBAC contract legend-0mc expands brand or station assignments to outlets).
// Never pass anything read from the request body, query or a client header.

import {
  outletScopeDataSchema,
  tenantContextDataSchema,
  assertTrustedTenantContext,
} from "./tenant.ts";
import type {
  OutletScope,
  OutletScopeData,
  ScopedTenantContext,
  TenantContext,
  TenantContextSource,
} from "./tenant.ts";
import { mintOutletScope, mintTenantContext } from "./trust.ts";

if (typeof (globalThis as { document?: unknown }).document !== "undefined")
  throw new Error(
    "@starter/shared/core/server is server-only and must not be bundled for the browser",
  );

/** Mints a TenantContext after the server resolved the tenant (TEN-02). */
export function establishTenantContext(input: {
  tenantId: string;
  brandId: string | null;
  source: TenantContextSource;
}): TenantContext {
  const data = tenantContextDataSchema.parse(input);
  return mintTenantContext({ ...data }) as TenantContext;
}

/** Mints the outlet reach of verified role assignments for one tenant (TEN-03). */
export function establishOutletScope(
  tenant: TenantContext,
  assignment: OutletScopeData,
): OutletScope {
  assertTrustedTenantContext(tenant);
  const data = outletScopeDataSchema.parse(assignment);
  const scope =
    data.kind === "tenant"
      ? { kind: data.kind, tenantId: tenant.tenantId }
      : {
          kind: data.kind,
          tenantId: tenant.tenantId,
          outletIds: Object.freeze([...new Set(data.outletIds)]),
        };
  return mintOutletScope(scope) as unknown as OutletScope;
}

/** Tenant context + outlet scope, as services receive them. */
export function establishScopedTenantContext(
  tenant: TenantContext,
  assignment: OutletScopeData,
): ScopedTenantContext {
  return Object.freeze({
    tenant,
    outletScope: establishOutletScope(tenant, assignment),
  });
}
