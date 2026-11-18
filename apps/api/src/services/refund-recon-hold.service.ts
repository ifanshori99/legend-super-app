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
// 0 rupiah), a `synthetic_full` hold that is not already recorded, or one the
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
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  outlets,
  paymentEvidence,
  paymentIntents,
  paymentLinks,
  paymentProviderRefunds,
  refundReconHolds,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  HOLD_TRANSACTION_CONFLICT_REASON,
  recordProviderRefundInTx,
  REFUND_MAY_DUPLICATE_ANONYMOUS_REASON,
  pickUnboundAnonymousFact,
  pickUnboundFact,
  unmatchedAnonymousFacts,
  type ProviderRefundIdKind,
} from "./payment-provider-partial-refund.ts";
import { alertOwnRefundFailedUnverified } from "./payment-provider-refunded-alert.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { assertPaymentPermission } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";
import { lockDepositIntentsExclusive } from "./reservation-deposit-credit.ts";

type Query = ReturnType<typeof listEndpoint.query.parse>;
type Params = ReturnType<typeof resolveEndpoint.params.parse>;
type Input = ReturnType<typeof resolveEndpoint.body.parse>;
type Identity = NonNullable<Input["identity"]>;

const PROVIDER = "doit";

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Refund hold not found.");
const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);
/** 1055 G1: a hold without a refund id on a transaction that already has a
 * refund on record may be that same refund. */
const identityAmbiguous = (
  message = "This payment transaction already has a provider refund on record; this hold may be the same refund. Give the provider's refund id it matches (or a new one for a separate refund).",
) => new HttpError(409, "HOLD_IDENTITY_AMBIGUOUS", message);
const noAnonymousToMatch = () =>
  unprocessable(
    "No refund on record for this transaction is left to be the same as; count it as a separate refund or close it as not this intent.",
  );
/** 1055 G2: the refund id is on record for another provider transaction. */
const transactionConflict = () =>
  new HttpError(
    409,
    "HOLD_TRANSACTION_CONFLICT",
    "This refund id is already on record for another provider transaction; it cannot be counted against this one. Check the provider, then close the hold as not this intent.",
  );

type HoldRow = typeof refundReconHolds.$inferSelect;

type HoldLabels = {
  outletId: string | null;
  paymentReference: string | null;
  outletName: string | null;
};

function toView(hold: HoldRow, labels: HoldLabels, needsIdentity = false) {
  return refundReconHoldViewSchema.parse({
    id: hold.id,
    paymentIntentId: hold.paymentIntentId,
    outletId: labels.outletId,
    paymentReference: labels.paymentReference,
    outletName: labels.outletName,
    providerRefundId: hold.providerRefundId,
    amountIdr: hold.amountIdr,
    reason: hold.reason,
    flaggedAt: hold.flaggedAt.toISOString(),
    resolvedAt: hold.resolvedAt ? hold.resolvedAt.toISOString() : null,
    resolution: hold.resolution,
    resolutionNote: hold.resolutionNote,
    needsIdentity,
  });
}

/**
 * 1055 G1 (AP1): counting this open hold needs finance's `identity`: it names
 * a provider refund id and is either a report held as a possible duplicate of
 * a refund counted without an id, or its transaction has such a refund not yet
 * matched (`unmatchedAnonymousFacts`). The resolve enforces the same rule.
 */
async function holdNeedsIdentity(
  tx: Tx,
  tenantId: TenantId,
  hold: HoldRow,
): Promise<boolean> {
  if (hold.resolvedAt || hold.reason === HOLD_TRANSACTION_CONFLICT_REASON)
    return false;
  // A hold without a refund id (not a credit hold) asks once its transaction
  // has any refund on record (it may be that refund).
  const anonymous =
    hold.providerRefundId === null &&
    hold.reason !== "credit_used_before_provider_refund";
  if (!anonymous && hold.providerRefundIdKind !== "provider") return false;
  if (hold.reason === REFUND_MAY_DUPLICATE_ANONYMOUS_REASON) return true;
  let providerPaymentRef = hold.providerPaymentRef;
  if (!providerPaymentRef) {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, hold.paymentIntentId),
        ),
      );
    if (!intent) return false;
    providerPaymentRef = await heldPaymentRefOf(tx, tenantId, hold, intent);
  }
  if (providerPaymentRef === null) return false;
  if (anonymous) {
    const [onTransaction] = await tx
      .select({ id: paymentProviderRefunds.id })
      .from(paymentProviderRefunds)
      .where(
        and(
          eq(paymentProviderRefunds.tenantId, tenantId),
          eq(paymentProviderRefunds.paymentIntentId, hold.paymentIntentId),
          eq(paymentProviderRefunds.provider, PROVIDER),
          eq(paymentProviderRefunds.providerPaymentRef, providerPaymentRef),
        ),
      )
      .limit(1);
    return onTransaction !== undefined;
  }
  return (
    (await unmatchedAnonymousFacts(
      tx,
      tenantId,
      hold.paymentIntentId,
      providerPaymentRef,
    )) > 0
  );
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
      .select({
        hold: refundReconHolds,
        outletId: paymentIntents.outletId,
        paymentReference: paymentLinks.reference,
        outletName: outlets.name,
      })
      .from(refundReconHolds)
      .leftJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, refundReconHolds.tenantId),
          eq(paymentIntents.id, refundReconHolds.paymentIntentId),
        ),
      )
      .leftJoin(
        paymentLinks,
        and(
          eq(paymentLinks.tenantId, paymentIntents.tenantId),
          eq(paymentLinks.id, paymentIntents.paymentLinkId),
        ),
      )
      .leftJoin(
        outlets,
        and(
          eq(outlets.tenantId, paymentIntents.tenantId),
          eq(outlets.id, paymentIntents.outletId),
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
    const data = [];
    for (const row of page)
      data.push(
        toView(
          row.hold,
          row,
          await holdNeedsIdentity(tx, context.tenant.tenantId, row.hold),
        ),
      );
    return {
      data,
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
       WHERE p.tenant_id = r.tenant_id AND p.refund_id_kind = 'provider'
         AND p.provider_refund_id = r.provider_ref))`;

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

/** What counting a hold decided: the identity finance gave when it was
 * applied (stored on the hold), and the transaction it was applied to. */
type CountedHold = {
  identity: Identity | null;
  providerPaymentRef: string | null;
  /** 1063 F3: the fact without a refund id a `same_as_counted` hold matched. */
  matchedFactId?: string;
};

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
  /** 1055 G1: the provider refund id finance matched an anonymous hold to. */
  matchedRefundId?: string,
  /** 1055 G1 (AP1): what finance says a named hold is (see `holdNeedsIdentity`). */
  identity?: Identity,
): Promise<CountedHold> {
  const counted: CountedHold = { identity: null, providerPaymentRef: null };
  const tenantId = context.tenant.tenantId;
  const named = hold.providerRefundId;
  // The kind decides, never a prefix of the id (legend-yn1of, 1035). The table
  // sets it exactly when the id is set.
  const namedKind: ProviderRefundIdKind | null =
    named === null
      ? null
      : ((hold.providerRefundIdKind as ProviderRefundIdKind | null) ??
        "provider");
  // A `synthetic_full` hold works out the transaction's remainder itself; one
  // filed with 0 (1045 A1) must still be countable.
  if (named !== null && namedKind !== "synthetic_full" && hold.amountIdr <= 0)
    throw unprocessable("This hold has no amount to count against the intent.");
  const record = async (
    refundIdKind: ProviderRefundIdKind,
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
        refundIdKind,
        providerPaymentRef,
        amountIdr,
        source: "refund_webhook",
        expectedIntentId: intent.id,
        force: true,
        quiet: true,
        holdResolve: true,
        ...(topUp ? { topUp: true } : {}),
      },
      factAt,
    );
    return status;
  };
  // 1055 G2: a fact of the hold is one of its intent AND of its provider
  // transaction; the same id on another transaction is not.
  const rowOf = async (
    refundIdKind: ProviderRefundIdKind,
    providerRefundId: string,
    providerPaymentRef: string,
  ) => {
    const [row] = await tx
      .select({ id: paymentProviderRefunds.id })
      .from(paymentProviderRefunds)
      .where(
        and(
          eq(paymentProviderRefunds.tenantId, tenantId),
          eq(paymentProviderRefunds.paymentIntentId, intent.id),
          eq(paymentProviderRefunds.provider, PROVIDER),
          eq(paymentProviderRefunds.refundIdKind, refundIdKind),
          eq(paymentProviderRefunds.providerRefundId, providerRefundId),
          eq(paymentProviderRefunds.providerPaymentRef, providerPaymentRef),
        ),
      );
    return row;
  };
  /** Any fact of this kind and id in the tenant (its unique key). */
  const anyRowOf = async (
    refundIdKind: ProviderRefundIdKind,
    providerRefundId: string,
  ) => {
    const [row] = await tx
      .select({ id: paymentProviderRefunds.id })
      .from(paymentProviderRefunds)
      .where(
        and(
          eq(paymentProviderRefunds.tenantId, tenantId),
          eq(paymentProviderRefunds.provider, PROVIDER),
          eq(paymentProviderRefunds.refundIdKind, refundIdKind),
          eq(paymentProviderRefunds.providerRefundId, providerRefundId),
        ),
      )
      .limit(1);
    return row;
  };
  const notRecorded = () =>
    unprocessable("This refund could not be recorded against the intent.");
  // Counting books money against the payment, so nothing of ours may still be
  // on its way: a pending or approved refund of the intent refuses it (422,
  // nothing recorded, the hold stays open).
  // With `transactionRef` (1045 A1), a refund of a parked fund whose evidence
  // is ANOTHER transaction is not part of this one's money and does not block;
  // every other refund of the intent still does (restrictive).
  const assertNoRefundInFlight = async (transactionRef?: string) => {
    const onTransaction =
      transactionRef === undefined
        ? sql`true`
        : sql`NOT (r.unallocated_fund_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM payment_unallocated_funds f
              JOIN payment_evidence fe
                ON fe.tenant_id = f.tenant_id AND fe.id = f.evidence_id
             WHERE f.tenant_id = r.tenant_id
               AND f.id = r.unallocated_fund_id
               AND (fe.provider <> ${PROVIDER}
                 OR fe.provider_ref <> ${transactionRef})))`;
    const { rows: flying } = await tx.execute(sql`SELECT 1
      FROM payment_refunds r
      WHERE r.tenant_id = ${tenantId}::uuid
        AND r.payment_intent_id = ${intent.id}::uuid
        AND r.status IN ('pending', 'approved')
        AND ${onTransaction} LIMIT 1`);
    if (flying.length > 0)
      throw unprocessable(
        "A refund of this payment is still on its way; wait until it is final. A pending refund that was never sent must first be failed or cancelled by finance.",
      );
  };

  if (hold.reason === "credit_used_before_provider_refund") {
    // Credit used beyond what the DP still holds: the provider refund is
    // already on record, so counting adds no refund row. Nothing of ours may
    // be on its way; then the hold closes (legend-ua9ja).
    await assertNoRefundInFlight();
    return counted;
  }

  if (named !== null && namedKind === "synthetic_full") {
    // The provider's `refunded` status of the payment, filed while a refund of
    // ours ran. The hold does not store the transaction amount, so what is
    // left of the transaction is worked out here. It closes only when nothing
    // of ours is still on its way; whatever is not yet accounted for is
    // recorded first, so nothing more than the payment can ever leave.
    // The id of a `synthetic_full` hold is the raw provider payment id; a
    // payment id stored on the hold must be the same one.
    if (hold.providerPaymentRef !== null && hold.providerPaymentRef !== named)
      throw unprocessable(
        "The provider transaction of this refund is not known.",
      );
    const providerPaymentRef = named;
    await assertNoRefundInFlight(providerPaymentRef);
    const leftNow = () =>
      transactionLeftIdr(tx, tenantId, intent, providerPaymentRef);
    let left = await leftNow();
    if (left <= 0) return counted;
    if (!(await rowOf("synthetic_full", named, providerPaymentRef))) {
      // The recorder works out the remainder itself; it needs the amount of
      // the transaction only when no evidence names it.
      const status = await record(
        "synthetic_full",
        named,
        providerPaymentRef,
        Number(intent.amountIdr),
      );
      if (status === "retry" || status === "unbound") throw notRecorded();
      left = await leftNow();
    }
    if (left > 0) {
      // Part of the transaction is still not accounted for (a refund of ours
      // that failed since): top it up with exactly that, keyed by the hold.
      if (!(await rowOf("synthetic_hold", hold.id, providerPaymentRef)))
        await record("synthetic_hold", hold.id, providerPaymentRef, left, true);
      if (!(await rowOf("synthetic_hold", hold.id, providerPaymentRef)))
        throw notRecorded();
      left = await leftNow();
    }
    // Closed only with the whole transaction accounted for, to the rupiah.
    if (left !== 0) throw notRecorded();
    return counted;
  }

  await assertNoRefundInFlight();
  const providerPaymentRef = await heldPaymentRefOf(tx, tenantId, hold, intent);
  if (!providerPaymentRef)
    throw unprocessable(
      "The provider transaction of this refund is not known; the intent has more than one.",
    );
  // A hold that names no refund id is counted under its own id, or under the
  // provider's refund id finance matched it to (1055 G1).
  const refundIdKind: ProviderRefundIdKind =
    namedKind ??
    (matchedRefundId === undefined ? "synthetic_hold" : "provider");
  const providerRefundId = named ?? matchedRefundId ?? hold.id;
  // Already on record for this transaction: counted, nothing new (a matched id
  // binds the hold to that refund).
  if (await rowOf(refundIdKind, providerRefundId, providerPaymentRef))
    return counted;
  // 1055 G2: the same id on record for another transaction (or intent) is not
  // this hold's refund, and cannot be booked again under that id.
  if (await anyRowOf(refundIdKind, providerRefundId))
    throw transactionConflict();
  if (named !== null) {
    // 1055 G1 (AP1): a refund counted from a hold without a refund id on this
    // transaction, not yet matched, may be this very refund; and a report held
    // as its possible duplicate always is in doubt. Finance says which: never
    // guessed (a fact too many books the journal twice, one too few lets more
    // money out).
    const unmatched = await unmatchedAnonymousFacts(
      tx,
      tenantId,
      intent.id,
      providerPaymentRef,
    );
    if (
      hold.reason === REFUND_MAY_DUPLICATE_ANONYMOUS_REASON ||
      unmatched > 0
    ) {
      if (identity === undefined)
        throw identityAmbiguous(
          "This refund may be the refund already counted on this transaction without a refund id. Say whether it is the same refund or a separate one.",
        );
      if (identity === "same_as_counted") {
        // The same money: the hold matches one such refund (stored on the
        // hold when it closes). 1055 AV-P1: what the report returned beyond
        // that refund is booked too, under this hold's id (once), at most what
        // is left of the transaction: matched against the smallest such refund
        // (restrictive: never too little on the books).
        if (unmatched === 0) throw noAnonymousToMatch();
        const matchedFact = await pickUnboundAnonymousFact(
          tx,
          tenantId,
          intent.id,
          providerPaymentRef,
          hold.amountIdr,
        );
        // `unmatched > 0` counts facts net of older bindless matches: with no
        // fact to bind, nothing is left to be the same money.
        if (matchedFact === null) throw noAnonymousToMatch();
        const matchedIdr = matchedFact.amountIdr;
        const left = await transactionLeftIdr(
          tx,
          tenantId,
          intent,
          providerPaymentRef,
        );
        const rest = Math.min(hold.amountIdr - matchedIdr, left);
        if (rest > 0) {
          if (!(await rowOf("synthetic_hold", hold.id, providerPaymentRef)))
            await record(
              "synthetic_hold",
              hold.id,
              providerPaymentRef,
              idr(rest),
              true,
            );
          if (!(await rowOf("synthetic_hold", hold.id, providerPaymentRef)))
            throw notRecorded();
        }
        return {
          identity,
          providerPaymentRef,
          matchedFactId: matchedFact.id,
        };
      }
      counted.identity = identity;
    } else if (identity === "same_as_counted") throw noAnonymousToMatch();
  }
  let amountIdr = hold.amountIdr;
  if (named === null) {
    // 1055 G1: a refund already on record for this transaction may be this
    // very one; finance must say which (or prove a separate refund by its id).
    // Regression 1055: finance without a refund id says it with `identity`.
    if (matchedRefundId === undefined) {
      const { rows: onTransaction } = await tx.execute(sql`SELECT
          min(p.amount_idr)::text AS smallest
        FROM payment_provider_refunds p
        WHERE p.tenant_id = ${tenantId}::uuid
          AND p.payment_intent_id = ${intent.id}::uuid
          AND p.provider = ${PROVIDER}
          AND p.provider_payment_ref = ${providerPaymentRef}`);
      const smallest = onTransaction[0]?.smallest;
      const booked = smallest !== null && smallest !== undefined;
      if (booked && identity === undefined) throw identityAmbiguous();
      if (identity === "same_as_counted") {
        // The same money as a refund on record: what the hold names beyond
        // the smallest such refund is booked (AV-P1), at most what is left.
        if (!booked) throw noAnonymousToMatch();
        // 1063 P2-1: matched against a fact no other hold is matched to yet
        // (exact amount first, else the smallest), and bound to it, so one
        // fact never serves as the base of two differences.
        const matchedFact = await pickUnboundFact(
          tx,
          tenantId,
          intent.id,
          providerPaymentRef,
          hold.amountIdr,
        );
        if (matchedFact === null) throw noAnonymousToMatch();
        const left = await transactionLeftIdr(
          tx,
          tenantId,
          intent,
          providerPaymentRef,
        );
        const rest = Math.min(hold.amountIdr - matchedFact.amountIdr, left);
        if (rest > 0) {
          await record(
            "synthetic_hold",
            hold.id,
            providerPaymentRef,
            idr(rest),
            true,
          );
          if (!(await rowOf("synthetic_hold", hold.id, providerPaymentRef)))
            throw notRecorded();
        }
        return {
          identity,
          providerPaymentRef,
          matchedFactId: matchedFact.id,
        };
      }
      if (identity === "separate") counted.identity = identity;
    }
    // No refund id: at most what is left of the named transaction is counted
    // (restrictive: the hold amount, or all of what is left when it is 0).
    // Nothing left means nothing to count.
    const left = await transactionLeftIdr(
      tx,
      tenantId,
      intent,
      providerPaymentRef,
    );
    if (left <= 0) return counted;
    amountIdr = idr(hold.amountIdr > 0 ? Math.min(hold.amountIdr, left) : left);
  }
  await record(
    refundIdKind,
    providerRefundId,
    providerPaymentRef,
    amountIdr,
    named === null,
  );
  // Only a refund that is on record may close the hold: an echo of our own
  // refund, an unbound or a delayed one counted nothing.
  if (!(await rowOf(refundIdKind, providerRefundId, providerPaymentRef)))
    throw notRecorded();
  return counted;
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
        const synthetic =
          hold.providerRefundId !== null &&
          hold.providerRefundIdKind === "synthetic_full";
        // 1055 G1: a matched refund id only counts a hold that names none.
        if (request.providerRefundId !== undefined) {
          if (request.resolution !== "counted_against_intent")
            throw unprocessable(
              "A provider refund id is only given when counting the hold against the intent.",
            );
          if (
            hold.providerRefundId !== null ||
            hold.reason === "credit_used_before_provider_refund"
          )
            throw unprocessable(
              "This hold already names its refund; no other refund id can be given.",
            );
        }
        // 1055 G1 (AP1): identity only says what a counted named refund is.
        if (request.identity !== undefined) {
          if (request.resolution !== "counted_against_intent")
            throw unprocessable(
              "Same or separate refund is only chosen when counting the hold against the intent.",
            );
          // A provider refund id, or no refund id at all (not a credit hold);
          // never together with a matched refund id.
          if (!(
            hold.providerRefundIdKind === "provider" ||
            (hold.providerRefundId === null &&
              hold.reason !== "credit_used_before_provider_refund")
          ))
            throw unprocessable(
              "Same or separate refund can only be chosen for a refund hold, not for this one.",
            );
          if (request.providerRefundId !== undefined)
            throw unprocessable(
              "Give either the provider's refund id or same/separate, not both.",
            );
        }
        let counted: CountedHold = { identity: null, providerPaymentRef: null };
        if (request.resolution === "not_this_intent") {
          // Our own refund ran while the full refund was recorded: the money
          // may already have gone back, so it is only closed by counting it.
          if (synthetic)
            throw unprocessable(
              "This hold names the payment's own refund; it can only be counted against the intent.",
            );
        } else {
          counted = await countHold(
            tx,
            context,
            hold,
            intent,
            factAt,
            request.providerRefundId,
            request.identity,
          );
        }
        const [closed] = await tx
          .update(refundReconHolds)
          .set({
            resolvedAt: now,
            resolvedBy: actor,
            resolution: request.resolution,
            resolutionNote: request.note,
            resolutionIdentity: counted.identity,
            ...(counted.matchedFactId !== undefined
              ? { matchedFactId: counted.matchedFactId }
              : {}),
            // A `same_as_counted` match is counted per transaction: the one it
            // was matched on is stored when the hold did not name it.
            ...(counted.identity === "same_as_counted" &&
            hold.providerPaymentRef === null
              ? { providerPaymentRef: counted.providerPaymentRef }
              : {}),
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
        const [labels] = await tx
          .select({ reference: paymentLinks.reference, name: outlets.name })
          .from(paymentLinks)
          .leftJoin(
            outlets,
            and(
              eq(outlets.tenantId, paymentLinks.tenantId),
              eq(outlets.id, intent.outletId),
            ),
          )
          .where(
            and(
              eq(paymentLinks.tenantId, tenantId),
              eq(paymentLinks.id, intent.paymentLinkId),
            ),
          );
        return toView(closed, {
          outletId: intent.outletId,
          paymentReference: labels?.reference ?? null,
          outletName: labels?.name ?? null,
        });
      },
    );
  });
}

/**
 * legend-w2td5 (1045 F1): reason of the hold filed when a refund of ours that
 * may have reached the provider (a provider reference, a send attempt or a
 * pending poll) ends failed. Its failure does not prove the provider kept the
 * money: the provider may have returned it (our refund after all, or one it
 * made on its own whose webhook was lost). Until the provider says otherwise
 * the intent is held, so no second refund of it can be sent. Finance closes
 * it after checking the provider.
 */
export const OWN_REFUND_FAILED_UNVERIFIED = "own_refund_failed_unverified";

/**
 * Files the `OWN_REFUND_FAILED_UNVERIFIED` hold of one failed refund of ours,
 * once per refund (the event id is a stable hash of tenant and refund id, so a
 * replay adds none). The provider refund id of our refund when it answered one
 * (else none), the refunded transaction as `providerPaymentRef` (null when not
 * known), the refund's amount. A new hold alerts the supervisors and owners
 * once. Only finance closes it (the poller records a
 * `refunded` answer but never closes the hold: DOIT has no partial status,
 * so `paid` proves nothing). Lock
 * order: the caller holds the intent row (then fund and refund rows); the
 * deposit-intent locks are taken here, last, like `fileLiveOwnHold`.
 */
export async function fileOwnRefundFailedHoldInTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    tenantId: TenantId;
    intentId: string;
    outletId: string;
    refundId: string;
    /** The provider's refund id of our refund, when it answered one. */
    providerRefundId: string | null;
    amountIdr: number;
    providerPaymentRef: string | null;
    now: Date;
  },
): Promise<boolean> {
  // The hold limits the DP credit of the intent (`openReconHoldIdrSql`).
  await lockDepositIntentsExclusive(tx, input.tenantId, input.intentId);
  const hex = createHash("sha256")
    .update(
      `refund_recon_hold.own_failed\0${input.tenantId}\0${input.refundId.toLowerCase()}`,
    )
    .digest("hex");
  const webhookEventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  // 1045 A2: the hold names our refund's provider refund id (kind
  // `provider`), so counting it books that id and a late echo of it is a
  // duplicate, never a second fact.
  const insertHold = (providerRefundId: string | null) =>
    tx
      .insert(refundReconHolds)
      .values({
        tenantId: input.tenantId,
        paymentIntentId: input.intentId,
        webhookEventId,
        providerRefundId,
        providerRefundIdKind: providerRefundId === null ? null : "provider",
        providerPaymentRef: input.providerPaymentRef,
        amountIdr: idr(input.amountIdr),
        reason: OWN_REFUND_FAILED_UNVERIFIED,
        flaggedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
  let [held] = await insertHold(input.providerRefundId);
  if (!held && input.providerRefundId !== null) {
    // Not a replay of this hold: another hold of the intent already names the
    // id. This one is still filed, without it (counting it is then capped by
    // what is left of the transaction).
    const [replay] = await tx
      .select({ id: refundReconHolds.id })
      .from(refundReconHolds)
      .where(
        and(
          eq(refundReconHolds.tenantId, input.tenantId),
          eq(refundReconHolds.webhookEventId, webhookEventId),
        ),
      );
    if (!replay) [held] = await insertHold(null);
  }
  if (!held) return false;
  // 1045 A3: told like the live-own hold, once (winner of the insert).
  await alertOwnRefundFailedUnverified(
    tx,
    context,
    {
      intentId: input.intentId,
      outletId: input.outletId,
      dedupKey: input.refundId.toLowerCase(),
      amountIdr: input.amountIdr,
    },
    input.now,
  );
  return true;
}
