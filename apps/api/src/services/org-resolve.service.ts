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
import type { TenantDomain } from "@starter/shared/platform";
import {
  domainVerificationRecord,
  normalizeHostname,
  resolveHost,
  tenantDomainSchema,
} from "@starter/shared/platform";
import { db } from "../db";
import { tenantDomains, tenants } from "../db/schema";

/** `tenant_domains` row -> contract DTO. The TXT record to publish is shown
 * only while the row is unverified and has a token. */
export function toTenantDomain(
  row: typeof tenantDomains.$inferSelect,
): TenantDomain {
  return tenantDomainSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    hostname: row.hostname,
    kind: row.kind,
    tlsStatus: row.tlsStatus,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verification:
      row.verifiedAt === null && row.verificationToken !== null
        ? domainVerificationRecord(row.hostname, row.verificationToken)
        : null,
    createdAt: row.createdAt.toISOString(),
  });
}

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
  const domains = rows.map((row) => toTenantDomain(row.domain));
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
