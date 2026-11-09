// Walled-garden sources for the edge Wi-Fi agent (bead legend-hsk; PRD v1.7
// §3 F5 + F25, FAC-11: ordering and payment stay reachable before Wi-Fi login).
//
// The list is built from data the edge already has, no new env key:
// - the tenant's verified `tenant_domains` hostnames (SELECT on that table is
//   open by design: host resolution runs before a tenant context exists);
// - the hosts of `WEB_URL` and `BETTER_AUTH_URL` (on the edge these are the
//   edge's own origins serving `/wifi`, ordering and checkout);
// - every payment host in `PAYMENT_WALLED_GARDEN_HOSTS`.
// `buildWalledGarden` (shared, pure) normalizes, dedupes, sorts and caps it.
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  PAYMENT_WALLED_GARDEN_HOSTS,
  type WalledGardenSources,
} from "@starter/shared/edge";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { tenantDomains } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";

/** Raw inputs for `buildWalledGarden`, scoped to the context's tenant. */
export async function loadWalledGardenSources(
  ctx: ScopedTenantContext,
): Promise<WalledGardenSources> {
  assertTrustedScopedContext(ctx);
  const tenantId = ctx.tenant.tenantId;
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select({ hostname: tenantDomains.hostname })
      .from(tenantDomains)
      .where(
        and(
          eq(tenantDomains.tenantId, tenantId),
          isNotNull(tenantDomains.verifiedAt),
        ),
      )
      .orderBy(asc(tenantDomains.hostname)),
  );
  const paymentHosts: string[] = Object.values(
    PAYMENT_WALLED_GARDEN_HOSTS,
  ).flatMap((hosts: readonly string[]) => [...hosts]);
  return {
    orderingHosts: rows.map((row) => row.hostname),
    paymentHosts,
    portalHosts: [
      new URL(env.WEB_URL).hostname,
      new URL(env.BETTER_AUTH_URL).hostname,
    ],
    extraHosts: [],
  };
}
