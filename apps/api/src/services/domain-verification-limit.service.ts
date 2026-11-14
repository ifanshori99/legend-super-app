// legend-8y5fc: the tenant/domain budget is shared by every API instance.
import { and, eq, lt, or, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { tenantDomains } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";

/** Reserve before DNS, committing even if the later lookup fails. Returns
 * whole seconds until retry, or null when one of the five slots was taken.
 * PostgreSQL serializes updates of this row, including across API processes. */
export async function reserveDomainVerificationAttempt(
  context: ScopedTenantContext,
  domainId: string,
): Promise<number | null> {
  const owned = and(
    eq(tenantDomains.tenantId, context.tenant.tenantId),
    eq(tenantDomains.id, domainId),
  );
  const expired = sql`(${tenantDomains.verificationWindowStartedAt} IS NULL OR
    ${tenantDomains.verificationWindowStartedAt} + interval '10 minutes' <= now())`;
  return withTenant(db, context, async (tx) => {
    const [reserved] = await tx
      .update(tenantDomains)
      .set({
        verificationAttempts: sql`CASE WHEN ${expired} THEN 1 ELSE ${tenantDomains.verificationAttempts} + 1 END`,
        verificationWindowStartedAt: sql`CASE WHEN ${expired} THEN now() ELSE ${tenantDomains.verificationWindowStartedAt} END`,
      })
      .where(and(owned, or(expired, lt(tenantDomains.verificationAttempts, 5))))
      .returning({ id: tenantDomains.id });
    if (reserved) return null;

    // No slot was written: distinguish a full window from a foreign/missing
    // domain without spending anyone else's budget. Use the DB clock for both
    // expiry and Retry-After, so skewed API clocks cannot open extra slots.
    const [current] = await tx
      .select({
        retryAfter: sql<number>`GREATEST(1, CEIL(EXTRACT(EPOCH FROM
          (${tenantDomains.verificationWindowStartedAt} + interval '10 minutes' - now()))))::integer`,
      })
      .from(tenantDomains)
      .where(owned)
      .limit(1);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Domain not found.");
    return current.retryAfter;
  });
}
