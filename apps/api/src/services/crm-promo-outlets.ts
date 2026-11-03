// Per-outlet promotion switch, engine side (contract PromotionOutlet; PRD v1.7
// §3.21 "Promo Engine"; bead legend-e5it). Admin endpoints live in
// crm-promo-outlets.service.ts.
//
// Reading (PRD silent, contract: "an outlet may switch a promotion off"): a
// promotion runs at every outlet of its tenant unless that outlet has a
// `promotion_outlets` row with `enabled = false`. No rows = all outlets, so
// tenant-wide promotions created before this switch keep working; an explicit
// `enabled = true` row is the same as no row.
//
// This module has no import from crm-promo-engine.ts, so the engine can call
// it without an import cycle.

import { and, eq, sql, type SQL } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { promotionOutlets, promotions } from "../db/schema";
import type { Tx } from "./permission-resolver";

/**
 * Candidate filter for the engine's promotion query: true when the promotion
 * is not switched off at `outletId`. Correlated on `promotions`, so it must be
 * used inside a query that selects from `promotions`.
 */
export function promotionEnabledAtOutlet(outletId: OutletId): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${promotionOutlets} WHERE ${promotionOutlets.tenantId} = ${promotions.tenantId} AND ${promotionOutlets.promotionId} = ${promotions.id} AND ${promotionOutlets.outletId} = ${outletId} AND ${promotionOutlets.enabled} = false)`;
}

/**
 * True when `promotionId` is switched off at `outletId`. A value voucher's id
 * (no promotion behind it) has no row, so it is never switched off here.
 */
export async function promotionDisabledAtOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  promotionId: string,
  outletId: OutletId,
): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: promotionOutlets.enabled })
    .from(promotionOutlets)
    .where(
      and(
        eq(promotionOutlets.tenantId, context.tenant.tenantId),
        eq(promotionOutlets.promotionId, promotionId),
        eq(promotionOutlets.outletId, outletId),
      ),
    )
    .limit(1);
  return row?.enabled === false;
}
