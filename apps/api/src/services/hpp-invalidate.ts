// HPP invalidation (bead legend-2qq, finding 3). Every write path that changes
// an input of `menu_costs` (menu links, recipes, prices, modifiers, sale
// location, outlet brand) calls `markHppStale` in the SAME transaction as the
// change. The worker job then rebuilds each stale outlet in full
// (hpp-recompute.service.ts `rebuildStaleOutlets`), so one tick shows the new
// cost. Kept free of heavy service imports so any service can import it
// without an import cycle.
//
// A rebuild clears `stale_at` only while it holds the `hpp_outlet_state` row
// lock it took BEFORE reading its inputs. A mark that commits later waits on
// that lock and sets `stale_at` again, so a change is never lost.

import { sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import type { Tx } from "./inventory-ops.shared.ts";

/**
 * Marks outlets stale: one outlet (`outletId`), every outlet of a brand
 * (`brandId`), or every outlet of the tenant when neither is given. Rows are
 * written in outlet id order so concurrent marks cannot deadlock.
 */
export async function markHppStale(
  tx: Tx,
  input: { tenantId: TenantId; brandId?: string; outletId?: string },
): Promise<void> {
  if (input.outletId !== undefined) {
    await tx.execute(sql`
      INSERT INTO hpp_outlet_state (tenant_id, outlet_id, stale_at)
      VALUES (${input.tenantId}::uuid, ${input.outletId}::uuid, clock_timestamp())
      ON CONFLICT (tenant_id, outlet_id)
      DO UPDATE SET stale_at = clock_timestamp()
    `);
    return;
  }
  const brandFilter =
    input.brandId === undefined
      ? sql``
      : sql`AND o.brand_id = ${input.brandId}::uuid`;
  await tx.execute(sql`
    INSERT INTO hpp_outlet_state (tenant_id, outlet_id, stale_at)
    SELECT o.tenant_id, o.id, clock_timestamp()
    FROM outlets o
    WHERE o.tenant_id = ${input.tenantId}::uuid ${brandFilter}
    ORDER BY o.id
    ON CONFLICT (tenant_id, outlet_id)
    DO UPDATE SET stale_at = clock_timestamp()
  `);
}
