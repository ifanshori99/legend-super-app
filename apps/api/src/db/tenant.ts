import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** All tenant queries must use the transaction passed to the callback. */
export async function withTenant<T>(
  database: Database,
  context: ScopedTenantContext,
  run: (tx: Transaction) => Promise<T>,
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
    return run(tx);
  });
}
