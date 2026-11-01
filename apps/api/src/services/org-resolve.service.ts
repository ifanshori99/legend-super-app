// Host -> tenant resolution (TEN-02). "Tenant ditentukan dari domain atau
// token, bukan dari parameter klien": the Host header is matched against
// verified `tenant_domains` rows whose tenant is active, and the API then mints
// the TenantContext with source "domain". Anything else fails closed.
//
// The table is readable without a tenant context by design (see
// platform-domains.ts); the pure decision stays in the platform contract
// (`resolveHost`) so the rules are shared with the web/edge code.

import { eq } from "drizzle-orm";
import type { HostResolution } from "@starter/shared/platform";
import {
  normalizeHostname,
  resolveHost,
  tenantDomainSchema,
} from "@starter/shared/platform";
import { db } from "../db";
import { tenantDomains, tenants } from "../db/schema";

export async function resolveHostname(host: string): Promise<HostResolution> {
  const hostname = normalizeHostname(host);
  if (hostname === null) return { ok: false, reason: "invalid_host" };
  const rows = await db
    .select({
      domain: tenantDomains,
      tenantStatus: tenants.status,
    })
    .from(tenantDomains)
    .innerJoin(tenants, eq(tenants.id, tenantDomains.tenantId))
    .where(eq(tenantDomains.hostname, hostname));
  const domains = rows.map((row) =>
    tenantDomainSchema.parse({
      id: row.domain.id,
      tenantId: row.domain.tenantId,
      brandId: row.domain.brandId,
      hostname: row.domain.hostname,
      kind: row.domain.kind,
      tlsStatus: row.domain.tlsStatus,
      verifiedAt: row.domain.verifiedAt?.toISOString() ?? null,
      createdAt: row.domain.createdAt.toISOString(),
    }),
  );
  const statuses = new Map(
    rows.map((row) => [row.domain.tenantId, row.tenantStatus] as const),
  );
  return resolveHost(hostname, domains, (tenantId) => statuses.get(tenantId));
}

/**
 * True only for a host that resolves to a verified domain of an active tenant.
 * Caddy's on-demand TLS ask uses it before issuing a certificate (TEN-02).
 */
export async function isVerifiedTenantHost(host: string): Promise<boolean> {
  return (await resolveHostname(host)).ok;
}
