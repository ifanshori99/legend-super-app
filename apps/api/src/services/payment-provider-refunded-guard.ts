// Shared guard (bead legend-7uqbs, 958): the provider already returned this
// money to the payer (`payment_unallocated_funds.provider_refunded_at` for a
// parked fund, `payment_intents.provider_refunded_after_paid_at` for a settled
// intent, both set by `flagProviderRefundedAfterRecordedInTx`). A refund of it
// would pay the same money twice and the outlet would lose it. Every step that
// files, approves or sends such a refund asks here. A fund refund looks only at
// its own fund: another provider transaction of the same intent is separate
// money, except that money of the intent's OWN provider transaction is also
// refunded when the intent itself carries the refunded answer (a fund parked
// by a late paid message that raced the refunded one is not flagged itself).
// legend-30hfs (967): an intent-level refund is also blocked when the refunds of
// ours plus the refunds the provider made on its own would exceed what the
// intent paid (`intentOverNetSql`).
// Nothing here touches a journal.
import type { TenantId } from "@starter/shared/core";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";
import type { Tx } from "./permission-resolver.ts";

export const PROVIDER_REFUNDED = "PROVIDER_REFUNDED";

type RefundSource = {
  paymentIntentId: string;
  unallocatedFundId: string | null;
};

/** SQL condition: the fund (given as tenant and id expressions) is blocked. Its
 * own flag, or the intent's refunded answer (`provider_refunded_at`, or
 * `provider_refunded_after_paid_at`) when the fund holds the intent's own
 * provider transaction, or a recorded provider refund (967) of that
 * transaction (or of the intent, for a fund with no evidence mapping). A fund
 * with no evidence mapping cannot be told apart, so it is blocked too (restrict when in doubt). */
function fundBlockedSql(tenantId: SQL, fundId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM payment_unallocated_funds f
    JOIN payment_intents i
      ON i.tenant_id = f.tenant_id AND i.id = f.payment_intent_id
    LEFT JOIN payment_evidence e
      ON e.tenant_id = f.tenant_id AND e.id = f.evidence_id
    WHERE f.tenant_id = ${tenantId}
      AND f.id = ${fundId}
      AND (f.provider_refunded_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM payment_provider_refunds pr
          WHERE pr.tenant_id = f.tenant_id
            AND pr.payment_intent_id = f.payment_intent_id
            AND (f.evidence_id IS NULL
              OR pr.evidence_id = f.evidence_id
              OR (pr.provider = e.provider
                AND pr.provider_payment_ref = e.provider_ref)))
        OR ((i.provider_refunded_at IS NOT NULL
             OR i.provider_refunded_after_paid_at IS NOT NULL)
          AND (f.evidence_id IS NULL
            OR (e.provider = i.provider AND e.provider_ref = i.provider_ref)))))`;
}

/** SQL condition (967): the provider's own refunds of the intent (given as
 * tenant and intent id expressions) are recorded, and together with our own
 * live intent-level refunds (not `failed`, this one included while it is live)
 * they exceed what the intent paid: evidence less parked funds, at most the
 * intent amount. Needs a recorded provider refund, so an intent the provider
 * never refunded is never blocked by it. */
function intentOverNetSql(tenantId: SQL, intentId: SQL): SQL {
  const foreign = providerRefundedForeignIdrSql(tenantId, intentId);
  return sql`(${foreign} > 0 AND (
    coalesce((SELECT sum(r.amount_idr) FROM payment_refunds r
      WHERE r.tenant_id = ${tenantId}
        AND r.payment_intent_id = ${intentId}
        AND r.status <> 'failed'
        AND r.unallocated_fund_id IS NULL), 0)
    + ${foreign}
    > coalesce((SELECT least(pi.amount_idr, greatest(
        coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
          WHERE e.tenant_id = pi.tenant_id AND e.payment_intent_id = pi.id), 0)
        - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
          WHERE f.tenant_id = pi.tenant_id AND f.payment_intent_id = pi.id), 0),
        0))
      FROM payment_intents pi
      WHERE pi.tenant_id = ${tenantId} AND pi.id = ${intentId}), 0)))`;
}

/** True when the money behind this refund source was already refunded by the
 * provider. A plain read: callers that must be exact hold the intent lock. */
export async function providerRefundedBlocks(
  tx: Tx,
  tenantId: TenantId,
  source: RefundSource,
): Promise<boolean> {
  if (source.unallocatedFundId) {
    const result = await tx.execute(
      sql`SELECT ${fundBlockedSql(sql`${tenantId}::uuid`, sql`${source.unallocatedFundId}::uuid`)} AS blocked`,
    );
    return result.rows[0]?.blocked === true;
  }
  const [intent] = await tx
    .select({ at: paymentIntents.providerRefundedAfterPaidAt })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, source.paymentIntentId),
      ),
    );
  if (!intent) return false;
  if (intent.at !== null) return true;
  const over = await tx.execute(
    sql`SELECT ${intentOverNetSql(sql`${tenantId}::uuid`, sql`${source.paymentIntentId}::uuid`)} AS blocked`,
  );
  return over.rows[0]?.blocked === true;
}

/** Rejects (409 PROVIDER_REFUNDED) a refund of money the provider already
 * returned to the payer. */
export async function assertNotProviderRefunded(
  tx: Tx,
  tenantId: TenantId,
  source: RefundSource,
): Promise<void> {
  if (await providerRefundedBlocks(tx, tenantId, source))
    throw new HttpError(
      409,
      PROVIDER_REFUNDED,
      "The payment provider already refunded this money to the payer; it cannot be refunded again.",
    );
}

/** The same check as one SQL condition on `payment_refunds` columns, for an
 * atomic conditional UPDATE (the right to send a payout). */
export const refundBlockedByProviderRefundSql = sql`(
  (${paymentRefunds.unallocatedFundId} IS NOT NULL AND ${fundBlockedSql(
    sql`${paymentRefunds.tenantId}`,
    sql`${paymentRefunds.unallocatedFundId}`,
  )})
  OR (${paymentRefunds.unallocatedFundId} IS NULL AND (
    EXISTS (
      SELECT 1 FROM payment_intents i
      WHERE i.tenant_id = ${paymentRefunds.tenantId}
        AND i.id = ${paymentRefunds.paymentIntentId}
        AND i.provider_refunded_after_paid_at IS NOT NULL)
    OR ${intentOverNetSql(
      sql`${paymentRefunds.tenantId}`,
      sql`${paymentRefunds.paymentIntentId}`,
    )})))`;
