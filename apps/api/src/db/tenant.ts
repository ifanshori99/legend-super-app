import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { PlatformError } from "@starter/shared/platform";
import { getRequestSupport } from "../lib/request-context";
import type * as schema from "./schema";
import { platformAdmins, supportAccessGrants } from "./schema";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** All tenant queries must use the transaction passed to the callback. */
export async function withTenant<T>(
  database: Database,
  context: ScopedTenantContext,
  run: (tx: Transaction) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  assertTrustedScopedContext(context);
  return database.transaction(async (tx) => {
    // A login capable of assuming a bypass or owning role can escape RLS even
    // if its current role looks safe. Check membership as well as current role.
    const result = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE (r.rolsuper OR r.rolbypassrls)
          AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))
      ) OR NOT pg_has_role(current_user, 'legend_app', 'MEMBER')
      OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND (pg_has_role(current_user, c.relowner, 'MEMBER') OR pg_has_role(session_user, c.relowner, 'MEMBER'))
      ) AS unsafe
    `);
    if (result.rows[0]?.unsafe !== false)
      throw new Error("Unsafe database role for tenant access");
    const outlets =
      context.outletScope.kind === "tenant"
        ? "*"
        : JSON.stringify(context.outletScope.outletIds);
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${context.tenant.tenantId}, true), set_config('app.outlet_ids', ${outlets}, true)`,
    );
    await lockSupportGrantForMutation(tx, context.tenant.tenantId);
    return run(tx);
  }, config);
}

/**
 * legend-hqjde: a support (impersonated) request that can change data re-checks
 * its grant inside the transaction that does the change, holding a FOR SHARE
 * lock on the grant row until that transaction ends. The revoke takes FOR
 * UPDATE on the same row (platform-support.service.ts endSupportAccessInternal),
 * so it waits for every in-flight support mutation and every later one sees
 * the ended grant: after a revoke answers 200 no support write commits.
 * The guard in middleware/support-session.ts runs before the body is read; this
 * is the check that cannot go stale. One helper for every route, because all
 * tenant data goes through withTenant. Normal sessions and reads cost nothing.
 */
async function lockSupportGrantForMutation(
  tx: Transaction,
  tenantId: string,
): Promise<void> {
  const support = getRequestSupport();
  if (!support?.mutation) return;
  // A read-only transaction (withTenantSnapshot) cannot commit a write, and
  // PostgreSQL refuses SELECT FOR SHARE in one.
  const readOnly = await tx.execute(
    sql`SELECT current_setting('transaction_read_only') = 'on' AS read_only`,
  );
  if (readOnly.rows[0]?.read_only === true) return;
  // A grant covers one tenant only: a support write into any other fails closed.
  if (support.tenantId !== tenantId)
    throw new PlatformError("SUPPORT_ACCESS_REQUIRED");
  const [grant] = await tx
    .select({
      accessMode: supportAccessGrants.accessMode,
      superAdminUserId: supportAccessGrants.superAdminUserId,
    })
    .from(supportAccessGrants)
    .where(
      and(
        eq(supportAccessGrants.id, support.grantId),
        eq(supportAccessGrants.tenantId, tenantId),
        isNull(supportAccessGrants.endedAt),
        gt(supportAccessGrants.expiresAt, sql`now()`),
      ),
    )
    .for("share");
  if (!grant || grant.superAdminUserId !== support.impersonatorUserId)
    throw new PlatformError("SUPPORT_ACCESS_REQUIRED");
  if (grant.accessMode !== "read_write")
    throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
  const [admin] = await tx
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(
      and(
        eq(platformAdmins.userId, support.impersonatorUserId),
        isNull(platformAdmins.revokedAt),
      ),
    )
    .limit(1);
  if (!admin) throw new PlatformError("SUPPORT_ACCESS_REQUIRED");
}
