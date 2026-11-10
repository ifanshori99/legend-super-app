// Per-outlet promotion switch, engine side (contract PromotionOutlet; PRD v1.7
// §3.21 "Promo Engine"; beads legend-e5it, legend-jh27). Admin endpoints live
// in crm-promo-outlets.service.ts.
//
// Reading (PRD silent, contract: "an outlet may switch a promotion off"),
// chosen per promotion by `promotions.outlet_scope`:
// - `all_except` (default): a promotion runs at every outlet of its tenant
//   unless that outlet has a `promotion_outlets` row with `enabled = false`.
//   No rows = all outlets, so tenant-wide promotions created before this switch
//   keep working; an explicit `enabled = true` row is the same as no row.
// - `only` (allowlist): a promotion runs only at outlets that have a row with
//   `enabled = true`. No row, or `enabled = false`, = does not run there.
//
// This module has no import from crm-promo-engine.ts, so the engine can call
// it without an import cycle.

import { and, eq, sql, type SQL } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { PromotionOutletScope } from "@starter/shared/crm";
import { promotionOutlets, promotions } from "../db/schema";
import type { Tx } from "./permission-resolver";

/**
 * True when a promotion with `scope` runs at an outlet whose switch row is
 * `rowEnabled` (null = no row). The one rule behind the SQL filter and the
 * per-promotion check.
 */
export function promotionRunsAtOutlet(
  scope: PromotionOutletScope,
  rowEnabled: boolean | null,
): boolean {
  return scope === "only" ? rowEnabled === true : rowEnabled !== false;
}

/**
 * Candidate filter for the engine's promotion query: true when the promotion
 * runs at `outletId` (see the reading above). Correlated on `promotions`, so
 * it must be used inside a query that selects from `promotions`.
 */
export function promotionEnabledAtOutlet(outletId: OutletId): SQL {
  const rowAt = (enabled: boolean) =>
    sql`EXISTS (SELECT 1 FROM ${promotionOutlets} WHERE ${promotionOutlets.tenantId} = ${promotions.tenantId} AND ${promotionOutlets.promotionId} = ${promotions.id} AND ${promotionOutlets.outletId} = ${outletId} AND ${promotionOutlets.enabled} = ${enabled})`;
  return sql`(CASE WHEN ${promotions.outletScope} = 'only' THEN ${rowAt(true)} ELSE NOT ${rowAt(false)} END)`;
}

/**
 * True when `promotionId` does not run at `outletId`: switched off (opt-out)
 * or not allowlisted (`only`). A value voucher's id (no promotion behind it)
 * has no promotions row, so it is never switched off here.
 */
export async function promotionDisabledAtOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  promotionId: string,
  outletId: OutletId,
): Promise<boolean> {
  const [row] = await tx
    .select({
      scope: promotions.outletScope,
      enabled: promotionOutlets.enabled,
    })
    .from(promotions)
    .leftJoin(
      promotionOutlets,
      and(
        eq(promotionOutlets.tenantId, promotions.tenantId),
        eq(promotionOutlets.promotionId, promotions.id),
        eq(promotionOutlets.outletId, outletId),
      ),
    )
    .where(
      and(
        eq(promotions.tenantId, context.tenant.tenantId),
        eq(promotions.id, promotionId),
      ),
    )
    .limit(1);
  return row === undefined
    ? false
    : !promotionRunsAtOutlet(row.scope, row.enabled);
}
