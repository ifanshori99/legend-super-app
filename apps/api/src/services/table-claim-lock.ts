// legend-ec6fa: the per-order advisory lock between a table claim and the
// earn consumer's reversal (refund or void) of that order.
//
// A claim redeems a unit (the UPDATE checks "not refunded") and posts its
// earn row in one transaction. A refund event that is handled while that
// transaction is still open cannot see the uncommitted earn row, so the
// points would survive the reversal. The claim therefore takes this lock
// shared and the reversal takes it exclusive: the reversal waits for every
// open claim of the order and then sees its rows, and a claim that starts
// later sees the refund.
//
// Lock order on both sides: order lock first, profile lock second. Keep the
// key in this one place so the two sides cannot drift apart.

import { sql } from "drizzle-orm";
import type { Tx } from "./menu-internals.ts";

function orderClaimLockKey(tenantId: string, orderId: string): string {
  return `table-claim-order:${tenantId}:${orderId}`;
}

/** Nonblocking retry workers must never let one refund stall the sweep. */
export async function tryLockOrderForClaim(
  tx: Pick<Tx, "execute">,
  tenantId: string,
  orderId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${orderClaimLockKey(tenantId, orderId)}, 0)) AS locked`,
  );
  return result.rows[0]?.locked === true;
}

/** Shared: a claim of one or more units of these orders. Ascending id order. */
export async function lockOrdersForClaim(
  tx: Pick<Tx, "execute">,
  tenantId: string,
  orderIds: Iterable<string>,
): Promise<void> {
  for (const orderId of [...new Set(orderIds)].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${orderClaimLockKey(tenantId, orderId)}, 0))`,
    );
}

/** Exclusive: the reversal of a claim's points for one order. */
export async function lockOrderForClaimReversal(
  tx: Pick<Tx, "execute">,
  tenantId: string,
  orderId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${orderClaimLockKey(tenantId, orderId)}, 0))`,
  );
}
