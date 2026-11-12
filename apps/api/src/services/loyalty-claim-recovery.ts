// Retry only pauses caused by transient lock contention. A genuinely
// ambiguous/mismatched entity remains parked for manual reconciliation.
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { billSplits, loyaltyClaimPauses } from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import type { Tx } from "./menu-internals.ts";
import { checkLoyaltyOutletEntity } from "./loyalty-entity-guard.ts";
import { orderRefunded, orderTraining } from "./table-claim.service.ts";
import { tryLockOrderForClaim } from "./table-claim-lock.ts";

/** Called with one order already identified, under a savepoint. */
export async function retryBusyClaimInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  pauseId: string,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [probe] = await tx
    .select()
    .from(loyaltyClaimPauses)
    .where(
      and(
        eq(loyaltyClaimPauses.tenantId, tenantId),
        eq(loyaltyClaimPauses.id, pauseId),
        eq(loyaltyClaimPauses.state, "busy"),
      ),
    );
  if (!probe) return;
  let orderId = probe.orderId;
  if (probe.splitId) {
    const [split] = await tx
      .select({ orderId: billSplits.orderId })
      .from(billSplits)
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.id, probe.splitId),
        ),
      );
    orderId = split?.orderId ?? null;
  }
  if (!orderId) return;
  if (!(await tryLockOrderForClaim(tx, tenantId, orderId))) return;
  await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .for("update", { noWait: true });
  if (probe.splitId)
    await tx
      .select({ id: billSplits.id })
      .from(billSplits)
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.id, probe.splitId),
        ),
      )
      .for("update", { noWait: true });
  const [pause] = await tx
    .select()
    .from(loyaltyClaimPauses)
    .where(
      and(
        eq(loyaltyClaimPauses.tenantId, tenantId),
        eq(loyaltyClaimPauses.id, pauseId),
        eq(loyaltyClaimPauses.state, "busy"),
      ),
    )
    .for("update", { noWait: true });
  if (!pause) return;
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        sql`${orders.status} <> 'voided'`,
        sql`${orders.customerProfileId} IS NULL`,
        sql`NOT ${orderRefunded(tenantId)}`,
        sql`NOT ${orderTraining(tenantId)}`,
      ),
    );
  if (!order) return; // Keep the remaining time while a pending refund may still fail.
  if (probe.splitId) {
    const [split] = await tx
      .select({ id: billSplits.id })
      .from(billSplits)
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.id, probe.splitId),
          eq(billSplits.status, "paid"),
          sql`${billSplits.claimRedeemedAt} IS NULL`,
        ),
      );
    if (!split) return;
  }
  const verdict = await checkLoyaltyOutletEntity(tx, tenantId, [
    pause.outletId,
  ]);
  if (verdict === "busy") return;
  await tx
    .update(loyaltyClaimPauses)
    .set(
      verdict === "ok"
        ? {
            state: "active",
            resumeDeadline: new Date(now.getTime() + pause.remainingMs),
          }
        : { state: "ambiguous" },
    )
    .where(
      and(
        eq(loyaltyClaimPauses.tenantId, tenantId),
        eq(loyaltyClaimPauses.id, pauseId),
        eq(loyaltyClaimPauses.state, "busy"),
      ),
    );
}

/** Recovery on request also works when the background worker is offline. */
export async function retryBusyClaimsForSessionInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM loyalty_claim_pauses p
     WHERE p.tenant_id = ${tenantId} AND p.state = 'busy'
       AND (EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = p.tenant_id AND o.id = p.order_id AND o.table_session_id = ${sessionId}::uuid)
         OR EXISTS (SELECT 1 FROM bill_splits s WHERE s.tenant_id = p.tenant_id AND s.id = p.split_id AND s.table_session_id = ${sessionId}::uuid))
     ORDER BY p.id
  `);
  for (const row of rows.rows) {
    try {
      await tx.transaction((savepoint) =>
        retryBusyClaimInTransaction(savepoint, context, row.id, now),
      );
    } catch (error) {
      let current: unknown = error;
      let contention = false;
      for (
        let depth = 0;
        depth < 5 && current && typeof current === "object";
        depth += 1
      ) {
        const item = current as { code?: unknown; cause?: unknown };
        if (item.code === "55P03") contention = true;
        current = item.cause;
      }
      if (!contention) throw error;
    }
  }
}

/** Worker uses a separate bounded transaction for each pause. */
export async function retryBusyLoyaltyClaims(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  let cursor: string | undefined;
  while (true) {
    const rows = await withTenant(db, context, (tx) =>
      tx
        .select({ id: loyaltyClaimPauses.id })
        .from(loyaltyClaimPauses)
        .where(
          and(
            eq(loyaltyClaimPauses.tenantId, tenantId),
            eq(loyaltyClaimPauses.state, "busy"),
            cursor ? gt(loyaltyClaimPauses.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(loyaltyClaimPauses.id))
        .limit(100),
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await withTenant(db, context, (tx) =>
          retryBusyClaimInTransaction(tx, context, row.id, now),
        );
      } catch (error) {
        let current: unknown = error;
        let contention = false;
        for (
          let depth = 0;
          depth < 5 && current && typeof current === "object";
          depth += 1
        ) {
          const item = current as { code?: unknown; cause?: unknown };
          if (item.code === "55P03") contention = true;
          current = item.cause;
        }
        if (!contention) throw error;
      }
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < 100) break;
  }
}
