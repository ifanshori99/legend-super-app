import { brandIdSchema, tenantIdSchema } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { pool } from "../db";
import { DEV_LOCAL_TENANT_DOMAINS } from "../db/dev-local-tenant-domains";

/** Only the app's explicitly enabled synthetic-development wrapper calls this.
 * The public-DNS resolver and on-demand TLS policy deliberately stay strict. */
export async function resolveDevLocalTenantHost(host: string) {
  const match = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match) return null;
  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (port < 1 || port > 65535) return null;
  }
  const domain = DEV_LOCAL_TENANT_DOMAINS.find(
    (entry) => entry.hostname === match[1],
  );
  if (!domain) return null;

  // Pin both the reserved seed id and hostname: an arbitrary domain row is
  // never a local-development alias. Missing or unverified seed rows fail closed.
  const result = await pool.query<{ tenant_id: string; brand_id: string }>(
    `SELECT d.tenant_id, d.brand_id
       FROM tenant_domains d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.id = $1 AND d.hostname = $2
        AND d.tenant_id = $3 AND d.brand_id = $4
        AND d.verified_at IS NOT NULL
        AND t.status = 'active'`,
    [
      domain.id,
      domain.hostname,
      cafeLegendPlatformFixtures.tenant.id,
      cafeLegendPlatformFixtures.brand.id,
    ],
  );
  const row = result.rows[0];
  return row
    ? {
        tenantId: tenantIdSchema.parse(row.tenant_id),
        brandId: brandIdSchema.parse(row.brand_id),
      }
    : null;
}
