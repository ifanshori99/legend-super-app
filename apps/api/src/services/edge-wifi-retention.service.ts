// Edge Wi-Fi grant retention (bead legend-y2dg; PRD v1.7 §3 F5 + F25).
//
// `wifi_device_grants` is an edge-local ledger that only grows. A terminal row
// (superseded, revoked, failed) is kept for WIFI_GRANT_RETENTION_DAYS after
// `ended_at` (audit window) and then deleted. Rules:
// - A row whose controller revoke still has to be (re)sent
//   (`revoke_retry_at IS NOT NULL`) is never deleted: the reference is needed
//   to finish the revoke.
// - One statement, so a concurrent writer never sees half a purge. The
//   `superseded_by` self-FK is never broken: a row still referenced by a row
//   that is kept stays, and so does everything that kept row points at
//   (recursive walk down the chain).
// - Scope is the caller's tenant and outlet scope (RLS, and explicit filters).
//
// Permissions are checked by the caller (the Wi-Fi agent runtime), not here.
import { sql, type SQL } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";

export const WIFI_GRANT_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export async function purgeExpiredWifiGrants(
  database: typeof db,
  context: ScopedTenantContext,
  now: Date,
): Promise<number> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const cutoff = new Date(
    now.getTime() - WIFI_GRANT_RETENTION_DAYS * DAY_MS,
  ).toISOString();
  let outletFilter: SQL = sql``;
  if (context.outletScope.kind === "outlets") {
    const ids = context.outletScope.outletIds;
    if (ids.length === 0) return 0;
    outletFilter = sql`AND outlet_id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`;
  }
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(sql`
      WITH RECURSIVE candidates AS (
        SELECT id FROM wifi_device_grants
        WHERE tenant_id = ${tenantId}::uuid ${outletFilter}
          AND status IN ('superseded', 'revoked', 'failed')
          AND ended_at < ${cutoff}::timestamptz
          AND revoke_retry_at IS NULL
      ),
      kept AS (
        SELECT s.superseded_by AS id FROM wifi_device_grants s
        WHERE s.tenant_id = ${tenantId}::uuid AND s.superseded_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.id = s.id)
        UNION
        SELECT g.superseded_by FROM wifi_device_grants g
        JOIN kept k ON g.id = k.id
        WHERE g.tenant_id = ${tenantId}::uuid AND g.superseded_by IS NOT NULL
      )
      DELETE FROM wifi_device_grants d
      WHERE d.tenant_id = ${tenantId}::uuid
        AND EXISTS (SELECT 1 FROM candidates c WHERE c.id = d.id)
        AND NOT EXISTS (SELECT 1 FROM kept k WHERE k.id = d.id)
      RETURNING d.id
    `);
    return result.rows.length;
  });
}
