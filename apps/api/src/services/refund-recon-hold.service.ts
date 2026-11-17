// legend-vp4ta (brief 1025b, money + permission): finance closes a
// refund_recon_hold. An open hold stops every refund, payout and fund refund of
// its intent; nothing else sets `resolved_at`.
//
// Closing never pays anyone and never sets a stamp by itself:
// - `not_this_intent`: the money the provider returned is not this payment's;
//   the hold is only closed.
// - `counted_against_intent`: it is this payment's. It is recorded as a
//   provider refund (the same recorder the webhook uses, quiet: one row, one
//   `payment.provider_refunded` event, so the books and the refund/payout
//   limits count it) BEFORE the hold closes, in the same transaction. A refund
//   of the same id already recorded counts once (the recorder is idempotent).
// Restrictive on purpose: a hold that cannot be counted (no provider refund id,
// 0 rupiah), a `payment:<ref>` hold that is not already recorded, or one the
// recorder does not write, is refused with 422 and stays open.
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  isoDateTimeSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  listRefundReconHolds as listEndpoint,
  refundReconHoldViewSchema,
  resolveRefundReconHold as resolveEndpoint,
} from "@starter/shared/payment/admin";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  paymentEvidence,
  paymentIntents,
  paymentProviderRefunds,
  refundReconHolds,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { recordProviderRefundInTx } from "./payment-provider-partial-refund.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { assertPaymentPermission } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

type Query = ReturnType<typeof listEndpoint.query.parse>;
type Params = ReturnType<typeof resolveEndpoint.params.parse>;
type Input = ReturnType<typeof resolveEndpoint.body.parse>;

const PROVIDER = "doit";
/** Id prefix of the refund derived from a payment's own `refunded` status. */
const SYNTHETIC_PREFIX = "payment:";

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Refund hold not found.");
const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

type HoldRow = typeof refundReconHolds.$inferSelect;

function toView(hold: HoldRow, outletId: string | null) {
  return refundReconHoldViewSchema.parse({
    id: hold.id,
    paymentIntentId: hold.paymentIntentId,
    outletId,
    providerRefundId: hold.providerRefundId,
    amountIdr: hold.amountIdr,
    reason: hold.reason,
    flaggedAt: hold.flaggedAt.toISOString(),
    resolvedAt: hold.resolvedAt ? hold.resolvedAt.toISOString() : null,
    resolution: hold.resolution,
    resolutionNote: hold.resolutionNote,
  });
}

export async function listRefundReconHolds(
  context: ScopedTenantContext,
  actor: string,
  input: Query,
) {
  assertTrustedScopedContext(context);
  const query = listEndpoint.query.parse(input);
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actor,
      "payment.reconcile",
      { type: "tenant" },
      new Date(),
    );
    let cursor = sql`TRUE`;
    if (query.cursor) {
      const [flagged, id] = decodeCursor(query.cursor);
      if (typeof flagged !== "string" || typeof id !== "string")
        throw unprocessable("Invalid cursor.");
      cursor = sql`(${refundReconHolds.flaggedAt}, ${refundReconHolds.id}) < (${flagged}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select({ hold: refundReconHolds, outletId: paymentIntents.outletId })
      .from(refundReconHolds)
      .leftJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, refundReconHolds.tenantId),
          eq(paymentIntents.id, refundReconHolds.paymentIntentId),
        ),
      )
      .where(
        and(
          eq(refundReconHolds.tenantId, context.tenant.tenantId),
          query.status === "resolved"
            ? sql`${refundReconHolds.resolvedAt} IS NOT NULL`
            : sql`${refundReconHolds.resolvedAt} IS NULL`,
          cursor,
        ),
      )
      .orderBy(
        sql`${refundReconHolds.flaggedAt} DESC`,
        sql`${refundReconHolds.id} DESC`,
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => toView(row.hold, row.outletId)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.hold.flaggedAt.toISOString(), last.hold.id])
            : null,
      },
    };
  });
}

/** The provider transaction the held refund names: the intent's own, else the
 * one recorded transaction (evidence) of the intent. Null when in doubt. */
async function providerPaymentRefOf(
  tx: Tx,
  tenantId: TenantId,
  intent: typeof paymentIntents.$inferSelect,
): Promise<string | null> {
  if (intent.provider === PROVIDER && intent.providerRef)
    return intent.providerRef;
  const evidence = await tx
    .select({ providerRef: paymentEvidence.providerRef })
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, tenantId),
        eq(paymentEvidence.paymentIntentId, intent.id),
        eq(paymentEvidence.provider, PROVIDER),
      ),
    )
    .limit(2);
  return evidence.length === 1 ? (evidence[0]?.providerRef ?? null) : null;
}

type IntentRow = typeof paymentIntents.$inferSelect;

/** The provider payment id a hold is counted against: the one the webhook
 * stored on the hold; else the intent's only transaction. A hold of an intent
 * with another transaction (evidence) or a parked fund is in doubt: null. */
async function heldPaymentRefOf(
  tx: Tx,
  tenantId: TenantId,
  hold: HoldRow,
  intent: IntentRow,
): Promise<string | null> {
  if (hold.providerPaymentRef) return hold.providerPaymentRef;
  const { rows } = await tx.execute(sql`SELECT
      (SELECT count(*) FROM payment_evidence e
        WHERE e.tenant_id = ${tenantId}::uuid
          AND e.payment_intent_id = ${intent.id}::uuid)::int AS evidence,
      (SELECT count(*) FROM payment_unallocated_funds f
        WHERE f.tenant_id = ${tenantId}::uuid
          AND f.payment_intent_id = ${intent.id}::uuid)::int AS funds`);
  if (Number(rows[0]?.evidence ?? 0) > 1 || Number(rows[0]?.funds ?? 0) > 0)
    return null;
  return providerPaymentRefOf(tx, tenantId, intent);
}

/** Completed refunds of ours on one provider transaction that no provider row
 * echoes: those of the intent's own transaction (not a fund's), and those of a
 * parked fund whose evidence is this transaction (sent on the fund's own
 * transaction, whichever it is). A fund without that evidence is not counted. */
const ownCompletedIdrSql = (
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
     AND NOT EXISTS (SELECT 1 FROM payment_provider_refunds p
       WHERE p.tenant_id = r.tenant_id AND p.provider_refund_id = r.provider_ref))`;

/**
 * What is left of one provider transaction of the intent: its amount (the
 * recorded evidence of the reference, else the intent's own amount) minus the
 * provider refunds recorded on it, minus our completed refunds of it (see
 * `ownCompletedIdrSql`). Read under the intent lock.
 */
async function transactionLeftIdr(
  tx: Tx,
  tenantId: TenantId,
  intent: IntentRow,
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

/**
 * Records the refund of a hold as a provider refund of its intent, before the
 * hold closes (same transaction). Throws 422, leaving the hold open, whenever
 * the refund is not on record afterwards.
 */
async function countHold(
  tx: Tx,
  context: ScopedTenantContext,
  hold: HoldRow,
  intent: IntentRow,
  factAt: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const named = hold.providerRefundId;
  if (named !== null && hold.amountIdr <= 0)
    throw unprocessable("This hold has no amount to count against the intent.");
  const record = async (
    providerRefundId: string,
    providerPaymentRef: string,
    amountIdr: number,
    topUp = false,
  ) => {
    // Counted first: the limits and the journal see the refund before the
    // hold lets go of the intent. Quiet: this resolve is audited by the caller.
    const { status } = await recordProviderRefundInTx(
      tx,
      context,
      {
        provider: PROVIDER,
        providerRefundId,
        providerPaymentRef,
        amountIdr,
        source: "refund_webhook",
        expectedIntentId: intent.id,
        force: true,
        quiet: true,
        ...(topUp ? { topUp: true } : {}),
      },
      factAt,
    );
    return status;
  };
  const rowOf = async (providerRefundId: string) => {
    const [row] = await tx
      .select({ id: paymentProviderRefunds.id })
      .from(paymentProviderRefunds)
      .where(
        and(
          eq(paymentProviderRefunds.tenantId, tenantId),
          eq(paymentProviderRefunds.paymentIntentId, intent.id),
          eq(paymentProviderRefunds.provider, PROVIDER),
          eq(paymentProviderRefunds.providerRefundId, providerRefundId),
        ),
      );
    return row;
  };
  const notRecorded = () =>
    unprocessable("This refund could not be recorded against the intent.");

  if (named?.startsWith(SYNTHETIC_PREFIX)) {
    // The provider's `refunded` status of the payment, filed while a refund of
    // ours ran. The hold does not store the transaction amount, so what is
    // left of the transaction is worked out here. It closes only when nothing
    // of ours is still on its way; whatever is not yet accounted for is
    // recorded first, so nothing more than the payment can ever leave.
    const providerPaymentRef = named.slice(SYNTHETIC_PREFIX.length);
    const { rows: flying } = await tx.execute(sql`SELECT 1
      FROM payment_refunds r
      WHERE r.tenant_id = ${tenantId}::uuid
        AND r.payment_intent_id = ${intent.id}::uuid
        AND r.status IN ('pending', 'approved') LIMIT 1`);
    if (flying.length > 0)
      throw unprocessable(
        "A refund of this payment is still on its way; wait until it is final.",
      );
    const leftNow = () =>
      transactionLeftIdr(tx, tenantId, intent, providerPaymentRef);
    let left = await leftNow();
    if (left <= 0) return;
    if (!(await rowOf(named))) {
      // The recorder works out the remainder itself; it needs the amount of
      // the transaction only when no evidence names it.
      const status = await record(
        named,
        providerPaymentRef,
        Number(intent.amountIdr),
      );
      if (status === "retry" || status === "unbound") throw notRecorded();
      left = await leftNow();
    }
    if (left > 0) {
      // Part of the transaction is still not accounted for (a refund of ours
      // that failed since): top it up with exactly that.
      const topUp = `hold:${hold.id}`;
      if (!(await rowOf(topUp)))
        await record(topUp, providerPaymentRef, left, true);
      if (!(await rowOf(topUp))) throw notRecorded();
      left = await leftNow();
    }
    // Closed only with the whole transaction accounted for, to the rupiah.
    if (left !== 0) throw notRecorded();
    return;
  }

  const providerPaymentRef = await heldPaymentRefOf(tx, tenantId, hold, intent);
  if (!providerPaymentRef)
    throw unprocessable(
      "The provider transaction of this refund is not known; the intent has more than one.",
    );
  const providerRefundId = named ?? `hold:${hold.id}`;
  if (await rowOf(providerRefundId)) return;
  let amountIdr = hold.amountIdr;
  if (named === null) {
    // No refund id: at most what is left of the named transaction is counted
    // (restrictive: the hold amount, or all of what is left when it is 0).
    // Nothing left means nothing to count.
    const left = await transactionLeftIdr(
      tx,
      tenantId,
      intent,
      providerPaymentRef,
    );
    if (left <= 0) return;
    amountIdr = idr(hold.amountIdr > 0 ? Math.min(hold.amountIdr, left) : left);
  }
  await record(providerRefundId, providerPaymentRef, amountIdr, named === null);
  // Only a refund that is on record may close the hold: an echo of our own
  // refund, an unbound or a delayed one counted nothing.
  if (!(await rowOf(providerRefundId))) throw notRecorded();
}

export async function resolveRefundReconHold(
  context: ScopedTenantContext,
  actor: string,
  params: Params,
  input: Input,
  key: string,
) {
  assertTrustedScopedContext(context);
  const { holdId } = resolveEndpoint.params.parse(params);
  const request = resolveEndpoint.body.parse(input);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Lock order: payment intent -> hold. Resolves of two holds of one intent
    // and a webhook recording a refund of it are serialized by the intent.
    const [probe] = await tx
      .select({ paymentIntentId: refundReconHolds.paymentIntentId })
      .from(refundReconHolds)
      .where(
        and(
          eq(refundReconHolds.tenantId, tenantId),
          eq(refundReconHolds.id, holdId),
        ),
      );
    if (!probe) throw notFound();
    const now = new Date();
    const factAt = await lockIntentsForFact(
      tx,
      tenantId,
      [probe.paymentIntentId],
      now,
    );
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, probe.paymentIntentId),
        ),
      );
    if (!intent) throw notFound();
    const [hold] = await tx
      .select()
      .from(refundReconHolds)
      .where(
        and(
          eq(refundReconHolds.tenantId, tenantId),
          eq(refundReconHolds.id, holdId),
        ),
      )
      .for("update");
    if (!hold) throw notFound();
    await assertPaymentPermission(
      tx,
      context,
      actor,
      "payment.reconcile",
      { type: "outlet", id: intent.outletId },
      now,
    );
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actor,
      key,
      "resolve-refund-hold",
      { holdId, ...request },
      async () => {
        if (hold.resolvedAt)
          throw new HttpError(409, "CONFLICT", "Hold already resolved.");
        const refundId = hold.providerRefundId;
        const synthetic = refundId?.startsWith(SYNTHETIC_PREFIX) === true;
        if (request.resolution === "not_this_intent") {
          // Our own refund ran while the full refund was recorded: the money
          // may already have gone back, so it is only closed by counting it.
          if (synthetic)
            throw unprocessable(
              "This hold names the payment's own refund; it can only be counted against the intent.",
            );
        } else {
          await countHold(tx, context, hold, intent, factAt);
        }
        const [closed] = await tx
          .update(refundReconHolds)
          .set({
            resolvedAt: now,
            resolvedBy: actor,
            resolution: request.resolution,
            resolutionNote: request.note,
          })
          .where(
            and(
              eq(refundReconHolds.tenantId, tenantId),
              eq(refundReconHolds.id, holdId),
              sql`${refundReconHolds.resolvedAt} IS NULL`,
            ),
          )
          .returning();
        if (!closed)
          throw new HttpError(409, "CONFLICT", "Hold already resolved.");
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: intent.outletId,
            actorType: "user",
            actorId: actor,
            deviceId: null,
            action: "payment.refund_recon_hold_resolved",
            objectType: "payment_intent",
            objectId: intent.id,
            reason: request.note,
            maskedChanges: {
              before: { holdId, open: true },
              after: {
                holdId,
                open: false,
                resolution: request.resolution,
                providerRefundId: hold.providerRefundId,
                amountIdr: hold.amountIdr,
              },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: isoDateTimeSchema.parse(now.toISOString()),
          },
          ["holdId", "open", "resolution", "providerRefundId", "amountIdr"],
        );
        return toView(closed, intent.outletId);
      },
    );
  });
}
