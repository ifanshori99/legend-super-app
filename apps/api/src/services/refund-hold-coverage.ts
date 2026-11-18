// 1119 (ronde 12): one rule for closing a refund-recon hold as
// `counted_against_intent`. The hold closes only when the provider refund facts
// on record for ITS refund (same intent, refund id kind and id, provider
// transaction) add up to the hold's amount: the amounts are compared, never
// the mere presence of a fact. A fact below the hold leaves the hold open in
// full (it still counts against the refund limit); nothing lowers a hold.
//
// Leaf module (imports no refund service) so the hold resolver, the live-own
// auto-close and `openReconHoldIdrSql` share one definition.
import type { TenantId } from "@starter/shared/core";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { paymentIntents } from "../db/schema/index.ts";
import { ownRefundEchoesFactSql } from "./payment-provider-refunded-foreign-sql.ts";
import type { Tx } from "./permission-resolver.ts";

const PROVIDER = "doit";

/**
 * SQL: what the provider facts on record carry for the refund a hold names,
 * for a row aliased `h` (a `refund_recon_holds` row, or a row with the same
 * key columns). A fact that is the echo of our own refund is not counted (the
 * refund is already subtracted from the pool). A hold that names no
 * transaction (`provider_payment_ref` NULL) is covered by nothing.
 */
export const holdFactCoveredIdrSql: SQL = sql`coalesce((SELECT sum(hr.amount_idr)
          FROM payment_provider_refunds hr
          WHERE hr.tenant_id=h.tenant_id AND hr.payment_intent_id=h.payment_intent_id
            AND hr.provider=${PROVIDER}
            AND hr.refund_id_kind=h.provider_refund_id_kind
            AND hr.provider_refund_id=h.provider_refund_id
            AND hr.provider_payment_ref=h.provider_payment_ref
            AND NOT EXISTS (SELECT 1 FROM payment_refunds own
              WHERE own.status <> 'failed'
                AND ${ownRefundEchoesFactSql("own", "hr")})), 0)`;

/**
 * SQL predicate for the WHERE of an UPDATE that closes a hold (one atomic
 * statement): true when the facts cover the hold's amount. `holdId` is the id
 * column of the hold being updated.
 */
export const holdFactCoversSql = (tenantId: TenantId, holdId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM refund_recon_holds h
    WHERE h.tenant_id = ${tenantId}::uuid AND h.id = ${holdId}
      AND ${holdFactCoveredIdrSql} >= h.amount_idr)`;

export type HoldFactCoverage = {
  coveredIdr: number;
  heldIdr: number;
  covers: boolean;
};

/**
 * What the facts on record carry for one refund of one provider transaction
 * against the amount the hold holds. Read in the transaction (and under the
 * locks) that closes the hold.
 */
export async function holdFactCoverage(
  tx: Tx,
  tenantId: TenantId,
  key: {
    intentId: string;
    refundIdKind: string;
    providerRefundId: string;
    providerPaymentRef: string;
  },
  heldIdr: number,
): Promise<HoldFactCoverage> {
  const { rows } =
    await tx.execute(sql`SELECT ${holdFactCoveredIdrSql}::text AS covered
    FROM (SELECT ${tenantId}::uuid AS tenant_id,
        ${key.intentId}::uuid AS payment_intent_id,
        ${key.refundIdKind}::text AS provider_refund_id_kind,
        ${key.providerRefundId}::text AS provider_refund_id,
        ${key.providerPaymentRef}::text AS provider_payment_ref) h`);
  const coveredIdr = Number(rows[0]?.covered ?? 0);
  return { coveredIdr, heldIdr, covers: coveredIdr >= heldIdr };
}

/** Completed refunds of ours on one provider transaction that no provider row
 * echoes: those of the intent's own transaction (not a fund's), and those of a
 * parked fund whose evidence is this transaction (sent on the fund's own
 * transaction, whichever it is). A fund without that evidence is not counted. */
export const ownCompletedIdrSql = (
  tenantId: TenantId,
  intentId: string,
  providerPaymentRef: string,
  ownTransaction: boolean,
) => sql`(
  SELECT coalesce(sum(r.amount_idr), 0) FROM payment_refunds r
   WHERE r.tenant_id = ${tenantId}::uuid
     AND r.payment_intent_id = ${intentId}::uuid
     AND r.status = 'completed'
     AND ((r.unallocated_fund_id IS NULL AND ${ownTransaction}::boolean)
       OR EXISTS (SELECT 1 FROM payment_unallocated_funds f
         JOIN payment_evidence fe
           ON fe.tenant_id = f.tenant_id AND fe.id = f.evidence_id
         WHERE f.tenant_id = r.tenant_id
           AND f.id = r.unallocated_fund_id
           AND fe.provider = ${PROVIDER}
           AND fe.provider_ref = ${providerPaymentRef}))
     -- 1063 9uz9n: a fact echoes our refund only from the same intent and
     -- transaction (and not above our amount); else both count.
     AND NOT EXISTS (SELECT 1 FROM payment_provider_refunds p
       WHERE ${ownRefundEchoesFactSql("r", "p")}))`;

/**
 * What is left of one provider transaction of the intent: its amount (the
 * recorded evidence of the reference, else the intent's own amount) minus the
 * provider refunds recorded on it, minus our completed refunds of it (see
 * `ownCompletedIdrSql`). Read under the intent lock.
 */
export async function transactionLeftIdr(
  tx: Tx,
  tenantId: TenantId,
  intent: typeof paymentIntents.$inferSelect,
  providerPaymentRef: string,
): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT
      (SELECT sum(e.amount_idr) FROM payment_evidence e
        WHERE e.tenant_id = ${tenantId}::uuid
          AND e.payment_intent_id = ${intent.id}::uuid
          AND e.provider = ${PROVIDER}
          AND e.provider_ref = ${providerPaymentRef})::text AS evidence,
      (SELECT coalesce(sum(p.amount_idr), 0) FROM payment_provider_refunds p
        WHERE p.tenant_id = ${tenantId}::uuid
          AND p.payment_intent_id = ${intent.id}::uuid
          AND p.provider = ${PROVIDER}
          AND p.provider_payment_ref = ${providerPaymentRef})::text AS provider,
      ${ownCompletedIdrSql(tenantId, intent.id, providerPaymentRef, providerPaymentRef === intent.providerRef)}::text AS own`);
  const row = rows[0];
  const amount =
    row?.evidence == null ? Number(intent.amountIdr) : Number(row.evidence);
  return amount - Number(row?.provider ?? 0) - Number(row?.own ?? 0);
}
