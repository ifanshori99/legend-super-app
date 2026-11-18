// Refunds the PROVIDER made on its own for money we recorded as paid (bead
// legend-30hfs, 967; the full-refund case of 958 lives in
// `flagProviderRefundedAfterRecordedInTx`). A provider refund that is not the
// echo of one we sent is recorded once in `payment_provider_refunds` (unique
// per tenant, provider and provider refund id, so a retried webhook and a
// poller racing each other record it once). The winner of that insert writes
// the one audit row and the one supervisor alert. The sum of the recorded
// refunds of an intent is taken off what the intent may still refund or pay
// out (`providerRefundedForeignIdrSql`, used by `refundableBalance` and the
// payout guard): nobody is paid more than the money the provider did not
// already return. The winner of the insert also appends one
// `payment.provider_refunded` event in the same transaction (legend-tlm3h): the
// auto journal books it Dr customer_deposit / Cr gateway_clearing, so the
// ledger holds what the gateway kept, like a payout (`payment.refunded`). Only
// the recorded outcome emits; a duplicate, an echo of ours, a retry or an
// unbound message never does, so a replayed webhook or a racing poller books
// nothing twice (the journal key is the recorded row's id besides). Nothing
// else here touches a journal.
import { createHash } from "node:crypto";
import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  paymentEvidence,
  paymentIntents,
  paymentProviderRefunds,
  paymentRefunds,
  refundReconHolds,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { recordAudit } from "./core-audit.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import {
  alertCreditUsedBeforeProviderRefund,
  alertProviderPartialRefund,
  alertProviderRefundCountedWithLiveOwn,
  alertProviderRefundExceedsLeft,
  alertProviderRefundMayDuplicateAnonymous,
  alertProviderRefundTransactionConflict,
} from "./payment-provider-refunded-alert.ts";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";
import {
  creditUsedSurplusForIntent,
  flagCreditReconForIntent,
  lockDepositIntentsExclusive,
} from "./reservation-deposit-credit.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

const PROVIDER = "doit";

/**
 * What a provider refund id is (legend-yn1of + legend-uvjqq, 1035), stored next
 * to it (`refund_id_kind`) and part of its unique key. Every branch reads the
 * kind, never a prefix of the id: a provider may send any id.
 * - `provider`: the provider's own refund id, as sent.
 * - `synthetic_full`: the payment's own `refunded` status (the whole
 *   transaction); the id is the raw provider payment id.
 * - `synthetic_hold`: what finance counted from a recon hold that names no
 *   refund id (or the top-up of a `synthetic_full` hold); the id is the hold's.
 */
export const PROVIDER_REFUND_ID_KINDS = [
  "provider",
  "synthetic_full",
  "synthetic_hold",
] as const;
export type ProviderRefundIdKind = (typeof PROVIDER_REFUND_ID_KINDS)[number];

/**
 * 1055 G1: reason of the hold filed when the provider reports a refund id on a
 * transaction that has a refund finance counted from a hold without a refund
 * id (a `synthetic_hold` fact) not yet matched: the report may be that refund.
 */
export const REFUND_MAY_DUPLICATE_ANONYMOUS_REASON =
  "Refund penyedia mungkin sama dengan refund tanpa nomor yang sudah dihitung finance (REFUND_MAY_DUPLICATE_ANONYMOUS)";

/**
 * 1055 G2 (architect AP2-2): reason of the hold filed when the provider reports
 * a refund id on one transaction that is on record for another transaction (or
 * intent): the reports disagree on whose refund it is.
 */
export const HOLD_TRANSACTION_CONFLICT_REASON =
  "Nomor refund penyedia sudah tercatat di transaksi lain (HOLD_TRANSACTION_CONFLICT)";

/**
 * 1055 AV-P1: the smallest refund of one provider transaction finance counted
 * from a hold without a refund id (0 when none). A report finance says is the
 * same money is matched against it: restrictive, the most of the report is
 * then booked. Read under the intent lock.
 */
export async function smallestAnonymousFactIdr(
  tx: Tx,
  tenantId: string,
  intentId: string,
  providerPaymentRef: string,
): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT
      coalesce(min(p.amount_idr), 0)::text AS amount
    FROM payment_provider_refunds p
    JOIN refund_recon_holds h
      ON h.tenant_id = p.tenant_id
     AND h.payment_intent_id = p.payment_intent_id
     AND h.id::text = p.provider_refund_id
     AND h.provider_refund_id IS NULL
    WHERE p.tenant_id = ${tenantId}::uuid
      AND p.payment_intent_id = ${intentId}::uuid
      AND p.provider = ${PROVIDER}
      AND p.provider_payment_ref = ${providerPaymentRef}
      AND p.refund_id_kind = 'synthetic_hold'`);
  return Number(rows[0]?.amount ?? 0);
}

/**
 * 1055 G1: how many refunds of one provider transaction finance counted from a
 * hold without a refund id (`synthetic_hold` facts of such holds) are not yet
 * matched to a report of the provider: minus the holds of that transaction
 * finance closed as `same_as_counted` (each matches one; a hold without a
 * refund id closed so matches none, its own difference is one such refund).
 * `not_this_intent` matches none. Read under the intent lock.
 */
export async function unmatchedAnonymousFacts(
  tx: Tx,
  tenantId: string,
  intentId: string,
  providerPaymentRef: string,
): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT
      (SELECT count(*) FROM payment_provider_refunds p
        JOIN refund_recon_holds h
          ON h.tenant_id = p.tenant_id
         AND h.payment_intent_id = p.payment_intent_id
         AND h.id::text = p.provider_refund_id
         AND h.provider_refund_id IS NULL
        WHERE p.tenant_id = ${tenantId}::uuid
          AND p.payment_intent_id = ${intentId}::uuid
          AND p.provider = ${PROVIDER}
          AND p.provider_payment_ref = ${providerPaymentRef}
          AND p.refund_id_kind = 'synthetic_hold')::int AS anonymous,
      (SELECT count(*) FROM refund_recon_holds d
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.payment_intent_id = ${intentId}::uuid
          AND d.provider_payment_ref = ${providerPaymentRef}
          AND d.provider_refund_id IS NOT NULL
          AND d.resolution_identity = 'same_as_counted')::int AS matched`);
  return Math.max(
    Number(rows[0]?.anonymous ?? 0) - Number(rows[0]?.matched ?? 0),
    0,
  );
}

/** One string per (kind, id), for alert and hold dedup keys. A provider id is
 * kept as it was (stable keys); a synthetic one carries its kind after a NUL,
 * which no stored id can contain, so the two never meet. */
export function providerRefundKey(
  kind: ProviderRefundIdKind,
  providerRefundId: string,
): string {
  return kind === "provider"
    ? providerRefundId
    : `${kind}\0${providerRefundId}`;
}

export type ProviderRefundInput = {
  provider: string;
  /** The refund id within its kind (see `ProviderRefundIdKind`). */
  providerRefundId: string;
  /** What `providerRefundId` is. A `synthetic_full` id must be the provider
   * payment id itself. */
  refundIdKind: ProviderRefundIdKind;
  /** The provider transaction the refund names. */
  providerPaymentRef: string;
  amountIdr: number;
  source: "refund_webhook" | "payment_webhook" | "poller";
  /**
   * The intent the caller already checked the message against (the webhook
   * verifies the integration with no transaction open). Binding here must land
   * on the same intent, else the refund is `unbound` and nothing is written.
   */
  expectedIntentId: string;
  /** Skip the in-flight "retry" check and record (the retry window of the
   * caller is over: counting is the restrictive side, and a provider reference
   * of ours matched later is left out when the sum is read). */
  force?: boolean;
  /**
   * The caller already audits and alerts this refund (the full refund of 958,
   * `markProviderRefunded`): the row, the flags and the journal event are
   * written, the `payment.provider_refunded_partial` audit row and the alert
   * are not (legend-gjt5q, 1025 B).
   */
  quiet?: boolean;
  /**
   * Only the resolve of a refund recon hold passes it: the row tops up a
   * `synthetic_full` row already recorded for the transaction (the second
   * refund of one transaction is otherwise a duplicate of the first).
   */
  topUp?: boolean;
  /**
   * Only the resolve of a refund recon hold passes it: that resolve closes the
   * hold itself, so recording here never closes the live-own hold of the
   * report (legend-d7im9), else the resolve would find it closed.
   */
  holdResolve?: boolean;
};

export type ProviderRefundOutcome = {
  /**
   * recorded: new refund, audited and alerted. duplicate: already recorded
   * (nothing more written). own: the echo of a refund we sent (not counted).
   * retry: a refund of ours for the intent is in flight and has no provider
   * reference yet, so this may be its echo: nothing written, ask again later.
   * unbound: the payment is not one of this tenant's (or the input is not
   * usable): nothing written.
   */
  status: "recorded" | "duplicate" | "own" | "retry" | "unbound";
};

/**
 * Records one provider-made refund inside the caller's transaction. The intent
 * is bound within the context's tenant (and its outlets when the scope lists
 * some), by the intent's own provider reference, else by the reference of a
 * recorded provider transaction (evidence) of the intent; never another
 * tenant. Lock order: the intent, then its funds (same as
 * `flagProviderRefundedAfterRecordedInTx`).
 */
export async function recordProviderRefundInTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: ProviderRefundInput,
  now: Date,
): Promise<ProviderRefundOutcome> {
  const tenantId = context.tenant.tenantId;
  const { providerRefundId, providerPaymentRef, refundIdKind } = input;
  const refundKey = providerRefundKey(refundIdKind, providerRefundId);
  let amountIdr = input.amountIdr;
  // The remainder counted a refund of ours that is not final (1025 B).
  let countedLiveOwn = false;
  let tellSupervisors = false;
  /** The dedup key of the live-own hold of this report: a stable id of
   * (tenant, intent, provider transaction, refund kind and id). 1055 AV-P2:
   * the transaction is part of it, so the same id reported on another
   * transaction is held on its own. */
  const liveOwnHoldKey = (): string => {
    const hex = createHash("sha256")
      .update(
        `refund_recon_hold.live_own\0${tenantId}\0${input.expectedIntentId.toLowerCase()}\0${providerPaymentRef}\0${refundKey}`,
      )
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  /** Holds the intent (refunds and payouts stop) because the books count a
   * refund of ours that is not final, or because this report waits on a refund
   * of ours still in flight (legend-d7im9), and tells finance once. Keyed by
   * `liveOwnHoldKey`: a replay, or the case with no provider row at all, stays
   * one hold and one alert. */
  /** Closes the live-own hold of this report (legend-d7im9, 1045) once its
   * refund is on record and no refund of ours is in flight any more. Holds of
   * other reports are not touched; a hold resolve closes its own. */
  const closeLiveOwnHold = async (): Promise<void> => {
    if (input.holdResolve) return;
    await tx
      .update(refundReconHolds)
      .set({
        resolvedAt: now,
        resolution: "counted_against_intent",
        resolutionNote:
          "Otomatis: refund kami tidak lagi berjalan, refund penyedia dicatat",
      })
      .where(
        and(
          eq(refundReconHolds.tenantId, tenantId),
          eq(refundReconHolds.paymentIntentId, input.expectedIntentId),
          eq(refundReconHolds.webhookEventId, liveOwnHoldKey()),
          // 1055 AP2-1: the hold of this report's transaction only; a replay
          // of the same id on another transaction closes nothing.
          eq(refundReconHolds.providerPaymentRef, providerPaymentRef),
          isNull(refundReconHolds.resolvedAt),
        ),
      );
  };
  const fileLiveOwnHold = async (
    heldIdr: number,
    intentOutletId: string,
  ): Promise<void> => {
    // legend-xmtih: a hold limits the DP credit of the intent, so it is made
    // under the deposit-intent locks (taken after the intent row lock of step
    // 2, the order of a refund). Re-taking them in step 4 is a no-op.
    await lockDepositIntentsExclusive(tx, tenantId, input.expectedIntentId);
    const [held] = await tx
      .insert(refundReconHolds)
      .values({
        tenantId,
        paymentIntentId: input.expectedIntentId,
        webhookEventId: liveOwnHoldKey(),
        providerRefundId,
        providerRefundIdKind: refundIdKind,
        providerPaymentRef,
        amountIdr: idr(heldIdr),
        reason:
          "Refund penyedia dibukukan dengan menghitung refund kami yang belum final (REFUND_LIVE_OWN)",
        flaggedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
    if (held)
      await alertProviderRefundCountedWithLiveOwn(
        tx,
        context,
        {
          intentId: input.expectedIntentId,
          outletId: tellSupervisors ? intentOutletId : null,
          // Per transaction, like the hold (1055 AV-P2).
          providerRefundId: `${providerPaymentRef}\0${refundKey}`,
          amountIdr: heldIdr,
        },
        now,
      );
  };
  /** 1045 A2: holds a provider report larger than what is left of its
   * transaction (nothing booked), once per (intent, refund id); finance told
   * once. Same lock order as `fileLiveOwnHold`. */
  const fileExceedsLeftHold = async (
    heldIdr: number,
    intentOutletId: string,
  ): Promise<void> => {
    await lockDepositIntentsExclusive(tx, tenantId, input.expectedIntentId);
    const hex = createHash("sha256")
      .update(
        `refund_recon_hold.exceeds_left\0${tenantId}\0${input.expectedIntentId.toLowerCase()}\0${providerPaymentRef}\0${refundKey}`,
      )
      .digest("hex");
    const [held] = await tx
      .insert(refundReconHolds)
      .values({
        tenantId,
        paymentIntentId: input.expectedIntentId,
        webhookEventId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
        providerRefundId,
        providerRefundIdKind: refundIdKind,
        providerPaymentRef,
        amountIdr: idr(heldIdr),
        reason:
          "Refund penyedia melebihi sisa transaksi setelah refund yang sudah dibukukan (REFUND_EXCEEDS_LEFT)",
        flaggedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
    if (held)
      await alertProviderRefundExceedsLeft(
        tx,
        context,
        {
          intentId: input.expectedIntentId,
          outletId: intentOutletId,
          dedupKey: `${providerPaymentRef}\0${refundKey}`,
          amountIdr: heldIdr,
        },
        now,
      );
  };
  /** 1055 G1: holds a provider refund id reported on a transaction with a
   * `synthetic_hold` fact that may be this very refund (nothing booked), once
   * per (intent, refund id); finance told once. Same lock order as
   * `fileLiveOwnHold`. */
  const fileMayDuplicateAnonymousHold = async (
    heldIdr: number,
    intentOutletId: string,
  ): Promise<void> => {
    await lockDepositIntentsExclusive(tx, tenantId, input.expectedIntentId);
    const hex = createHash("sha256")
      .update(
        `refund_recon_hold.duplicate_anonymous\0${tenantId}\0${input.expectedIntentId.toLowerCase()}\0${providerPaymentRef}\0${refundKey}`,
      )
      .digest("hex");
    const [held] = await tx
      .insert(refundReconHolds)
      .values({
        tenantId,
        paymentIntentId: input.expectedIntentId,
        webhookEventId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
        providerRefundId,
        providerRefundIdKind: refundIdKind,
        providerPaymentRef,
        amountIdr: idr(heldIdr),
        reason: REFUND_MAY_DUPLICATE_ANONYMOUS_REASON,
        flaggedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
    if (held)
      await alertProviderRefundMayDuplicateAnonymous(
        tx,
        context,
        {
          intentId: input.expectedIntentId,
          outletId: intentOutletId,
          dedupKey: `${providerPaymentRef}\0${refundKey}`,
          amountIdr: heldIdr,
        },
        now,
      );
  };
  /** 1055 G2 (AP2-2): holds a provider refund id reported on this
   * transaction that is on record for another one, once per (intent,
   * transaction, refund id); finance told once. Same lock order as
   * `fileLiveOwnHold`. */
  const fileTransactionConflictHold = async (
    heldIdr: number,
    intentOutletId: string,
  ): Promise<void> => {
    await lockDepositIntentsExclusive(tx, tenantId, input.expectedIntentId);
    const hex = createHash("sha256")
      .update(
        `refund_recon_hold.transaction_conflict\0${tenantId}\0${input.expectedIntentId.toLowerCase()}\0${providerPaymentRef}\0${refundKey}`,
      )
      .digest("hex");
    const [held] = await tx
      .insert(refundReconHolds)
      .values({
        tenantId,
        paymentIntentId: input.expectedIntentId,
        webhookEventId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
        providerRefundId,
        providerRefundIdKind: refundIdKind,
        providerPaymentRef,
        amountIdr: idr(heldIdr),
        reason: HOLD_TRANSACTION_CONFLICT_REASON,
        flaggedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
    if (held)
      await alertProviderRefundTransactionConflict(
        tx,
        context,
        {
          intentId: input.expectedIntentId,
          outletId: intentOutletId,
          dedupKey: `${providerPaymentRef}\0${refundKey}`,
          amountIdr: heldIdr,
        },
        now,
      );
  };
  if (
    input.provider !== PROVIDER ||
    !PROVIDER_REFUND_ID_KINDS.includes(refundIdKind) ||
    (refundIdKind === "synthetic_full" &&
      providerRefundId !== providerPaymentRef) ||
    providerRefundId.length === 0 ||
    providerRefundId.length > 100 ||
    providerPaymentRef.length === 0 ||
    providerPaymentRef.length > 100 ||
    !Number.isSafeInteger(amountIdr) ||
    amountIdr <= 0
  )
    return { status: "unbound" };
  const outletIds =
    context.outletScope.kind === "outlets"
      ? context.outletScope.outletIds
      : null;
  const inScope = (column: SQL): SQL =>
    outletIds
      ? sql`${column} IN (${sql.join(
          outletIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql`true`;

  // 1. Bind the provider transaction to an intent of this tenant.
  const byIntent = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.provider, PROVIDER),
        eq(paymentIntents.providerRef, providerPaymentRef),
        inScope(sql`${paymentIntents.outletId}`),
      ),
    )
    .limit(2);
  const evidenceRows = await tx
    .select({
      id: paymentEvidence.id,
      intentId: paymentEvidence.paymentIntentId,
    })
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, tenantId),
        eq(paymentEvidence.provider, PROVIDER),
        eq(paymentEvidence.providerRef, providerPaymentRef),
        inScope(sql`${paymentEvidence.outletId}`),
      ),
    )
    .limit(2);
  // Two candidates is a doubt, not a guess: bind nothing. A recorded
  // transaction names its intent for certain, so it wins over the intent that
  // only carries the same reference.
  if (byIntent.length > 1 || evidenceRows.length > 1)
    return { status: "unbound" };
  const intentId = evidenceRows[0]?.intentId ?? byIntent[0]?.id;
  if (!intentId || intentId !== input.expectedIntentId)
    return { status: "unbound" };

  // 2. Lock the intent.
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
      ),
    )
    .for("update");
  if (!intent) return { status: "unbound" };
  // The recorded transaction of this reference, read under the lock (settlement
  // writes evidence under it). One that now names another intent is a race
  // with a settlement: write nothing, ask again.
  const [evidence] = await tx
    .select({
      id: paymentEvidence.id,
      intentId: paymentEvidence.paymentIntentId,
      amountIdr: paymentEvidence.amountIdr,
    })
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, tenantId),
        eq(paymentEvidence.provider, PROVIDER),
        eq(paymentEvidence.providerRef, providerPaymentRef),
      ),
    )
    .limit(1);
  if (evidence && evidence.intentId !== intent.id) return { status: "retry" };
  const evidenceId = evidence?.id ?? null;

  // 3. The echo of a refund we sent is not a provider refund of its own. A
  // failed refund of ours returned nothing, so it never matches. Only a
  // provider's own refund id can be the echo (a synthetic id is a payment id or
  // a hold id, never a refund reference of ours).
  const [own] =
    refundIdKind === "provider"
      ? await tx
          .select({ id: paymentRefunds.id })
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.tenantId, tenantId),
              eq(paymentRefunds.providerRef, providerRefundId),
              sql`${paymentRefunds.status} <> 'failed'`,
            ),
          )
          .limit(1)
      : [];
  if (own) return { status: "own" };
  // A refund of this intent we may have sent whose provider reference we do
  // not know yet: this message may be its echo, so count nothing for now.
  const inFlightRows = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.paymentIntentId, intent.id),
        eq(paymentRefunds.status, "approved"),
        isNull(paymentRefunds.providerRef),
        sql`(${paymentRefunds.payoutAttempts} > 0
          OR ${paymentRefunds.payoutPendingPolls} > 0
          OR ${paymentRefunds.payoutClaimToken} IS NOT NULL)`,
      ),
    );
  const inFlight = inFlightRows.length > 0;
  // The payment's own `refunded` status (synthetic id) decides below, once the
  // remainder is known (legend-tiyce): a live parked-fund refund of ours that
  // already covers all of it is held, not waited for.
  const waitForInFlight = inFlight && !input.force;
  // legend-d7im9 (1045): every "retry" that waits on a refund of ours still in
  // flight holds the intent first (same transaction, once per report): should
  // ours fail before the report is asked again, no new refund of the same money
  // may go out in between. The report is still asked again.
  // The hold carries the report's own amount: a resolve that counts it books
  // that refund id with the hold's amount, so it must be what the provider
  // returned, never our (maybe smaller) refund.
  if (waitForInFlight && refundIdKind !== "synthetic_full") {
    await fileLiveOwnHold(amountIdr, intent.outletId);
    return { status: "retry" };
  }

  // One transaction, one refund: the payment's own `refunded` status
  // (`synthetic_full`, the whole transaction) and a provider refund id of the
  // same transaction describe the same money, so the second never adds to it.
  const recorded = await tx
    .select({
      refundId: paymentProviderRefunds.providerRefundId,
      kind: paymentProviderRefunds.refundIdKind,
      amountIdr: paymentProviderRefunds.amountIdr,
    })
    .from(paymentProviderRefunds)
    .where(
      and(
        eq(paymentProviderRefunds.tenantId, tenantId),
        eq(paymentProviderRefunds.provider, PROVIDER),
        eq(paymentProviderRefunds.providerPaymentRef, providerPaymentRef),
      ),
    );
  if (refundIdKind === "synthetic_full") {
    // Refunds of ours on THIS provider transaction went back to the payer and
    // journal through `payment.refunded`: the provider's `refunded` status is
    // their echo, so they are not booked a second time (1025 B). A refund of a
    // parked fund of another transaction is not part of this money (same rule
    // as `ownRefundedIdrSql`); an intent-level refund belongs to the intent's
    // primary transaction only, never to a secondary one (1025d), and one already recorded as an echo row is in
    // `recorded` (counted there, not twice).
    const { rows: ours } = await tx.execute(sql`SELECT r.status,
        r.amount_idr::text AS amount, r.provider_ref,
        (r.unallocated_fund_id IS NOT NULL) AS fund,
        (r.provider_ref IS NOT NULL OR r.payout_attempts > 0
          OR r.payout_pending_polls > 0
          OR r.payout_claim_token IS NOT NULL) AS sent
      FROM payment_refunds r
      WHERE r.tenant_id = ${tenantId}::uuid
        AND r.payment_intent_id = ${intent.id}::uuid
        AND r.status NOT IN ('failed')
        AND ((r.unallocated_fund_id IS NULL
            AND ${intent.providerRef ?? null}::text
              IS NOT DISTINCT FROM ${providerPaymentRef}::text)
          OR EXISTS (SELECT 1 FROM payment_unallocated_funds f
            JOIN payment_evidence e
              ON e.tenant_id = f.tenant_id AND e.id = f.evidence_id
            WHERE f.tenant_id = r.tenant_id
              AND f.id = r.unallocated_fund_id
              AND e.payment_intent_id = ${intent.id}::uuid
              AND e.provider = ${PROVIDER}
              AND e.provider_ref = ${providerPaymentRef}))`);
    // Only a provider's own refund id can echo a refund of ours.
    const echoed = new Set(
      recorded
        .filter((row) => row.kind === "provider")
        .map((row) => row.refundId),
    );
    const unrecorded = ours.filter(
      (row) => !(row.provider_ref && echoed.has(String(row.provider_ref))),
    );
    const completed = unrecorded.filter((row) => row.status === "completed");
    const live = unrecorded.filter(
      (row) => row.status !== "completed" && row.sent === true,
    );
    // Refunds of ours still on their way count as sent: their money goes back
    // to the payer too (restrictive). When they leave nothing of the
    // transaction the provider's status is their echo.
    const ownIdr = [...completed, ...live].reduce(
      (sum, row) => sum + Number(row.amount),
      0,
    );
    // A refund of the bill still on its way (not a parked fund's, whose amount
    // is fixed): the provider's status may be its echo and the amount is not
    // final. Write nothing; the caller asks again later (when the retry window
    // is over, `force` counts it).
    const mustWait = !input.force && live.some((row) => row.fund !== true);
    // Without an evidence row the intent's own amount stands for the money
    // received; provider rows already recorded are taken off in both cases.
    const left =
      (evidence ? Number(evidence.amountIdr) : amountIdr) -
      recorded.reduce((sum, row) => sum + Number(row.amountIdr), 0) -
      ownIdr;
    // Counted after the retry window (a refund of the bill still unresolved):
    // the outlet supervisors hear of it too. A live parked-fund refund (fixed
    // amount, already told by the 958 alert) is told to the owners only.
    tellSupervisors = live.some((row) => row.fund !== true);
    const liveIdr = live.reduce((sum, row) => sum + Number(row.amount), 0);
    // 1045 A1: the hold carries all that is at risk of this transaction, its
    // remainder and our refunds of it still on their way. A refund of ours of
    // another transaction in flight leaves `live` empty here, and a hold of 0
    // would neither limit the credit nor let finance count it.
    const atRiskIdr = liveIdr + Math.max(left, 0);
    if (
      waitForInFlight &&
      !(left <= 0 && live.some((row) => !row.provider_ref && row.fund === true))
    ) {
      await fileLiveOwnHold(atRiskIdr, intent.outletId);
      return { status: "retry" };
    }
    if (left <= 0) {
      // Our refunds leave nothing of the transaction. A refund of the bill
      // not sent yet (no provider reference) is asked again inside the window.
      // A refund sent with a reference is NOT waited on: a pending answer
      // stores the reference and may still end failed (legend-04izi, 1035), and
      // while the provider's report waits for a retry nothing would stop a new
      // refund of the same money once ours fails. So it is held at once.
      if (live.length > 0) {
        if (
          !input.force &&
          live.some((row) => !row.provider_ref && row.fund !== true)
        ) {
          await fileLiveOwnHold(liveIdr, intent.outletId);
          return { status: "retry" };
        }
        // Otherwise (`force`, a sent refund, or only a parked fund's refund on
        // its way, legend-tiyce) a refund of ours still on its way is in flight:
        // nothing new is booked (ours journals itself), but the intent is held
        // (once) and finance and the supervisors told, so should ours fail its
        // refunds and payouts stay stopped until finance counts the provider's
        // refund. Never `own` without the hold.
        tellSupervisors = true;
        await fileLiveOwnHold(liveIdr, intent.outletId);
        return { status: "own" };
      }
      return { status: ownIdr > 0 ? "own" : "duplicate" };
    }
    if (mustWait) {
      await fileLiveOwnHold(atRiskIdr, intent.outletId);
      return { status: "retry" };
    }
    amountIdr = left;
    countedLiveOwn = live.length > 0;
  } else {
    // Finance topping up what the transaction still has left (resolve of a
    // recon hold) is added to the `synthetic_full` row on purpose.
    if (!input.topUp && recorded.some((row) => row.kind === "synthetic_full"))
      return { status: "duplicate" };
    // 1055 G1: a refund finance counted from a hold that names no refund id
    // (a `synthetic_hold` fact) may be this very report under its own id: the
    // remainder alone does not tell them apart. While such a fact of this
    // transaction is not matched to a report (`unmatchedAnonymousFacts`), the
    // report books nothing and waits for finance as a hold. A report already
    // held so, or matched to it, stays a duplicate. A hold resolve checks
    // identity itself (`countHold`, finance says which) and is booked.
    if (
      refundIdKind === "provider" &&
      !input.holdResolve &&
      !recorded.some(
        (row) => row.kind === "provider" && row.refundId === providerRefundId,
      )
    ) {
      // Held already for finance, or matched by finance to a counted refund
      // (any hold of this id closed `same_as_counted`): nothing more.
      const [held] = await tx
        .select({ id: refundReconHolds.id })
        .from(refundReconHolds)
        .where(
          and(
            eq(refundReconHolds.tenantId, tenantId),
            eq(refundReconHolds.paymentIntentId, intent.id),
            eq(refundReconHolds.providerRefundIdKind, "provider"),
            eq(refundReconHolds.providerRefundId, providerRefundId),
            eq(refundReconHolds.providerPaymentRef, providerPaymentRef),
            or(
              and(
                eq(
                  refundReconHolds.reason,
                  REFUND_MAY_DUPLICATE_ANONYMOUS_REASON,
                ),
                isNull(refundReconHolds.resolvedAt),
              ),
              eq(refundReconHolds.resolutionIdentity, "same_as_counted"),
            ),
          ),
        )
        .limit(1);
      if (held) return { status: "duplicate" };
      if (
        (await unmatchedAnonymousFacts(
          tx,
          tenantId,
          intent.id,
          providerPaymentRef,
        )) > 0
      ) {
        await fileMayDuplicateAnonymousHold(amountIdr, intent.outletId);
        return { status: "duplicate" };
      }
    }
    // 1045 A2: a provider refund id never books more than what is left of the
    // transaction after the refunds already booked on it (a refund finance
    // counted from a hold may be this very one under another id). The whole
    // report waits for finance as a hold; nothing is booked. A replay of an id
    // already on record is left to the insert below (duplicate).
    if (
      refundIdKind === "provider" &&
      !recorded.some(
        (row) => row.kind === "provider" && row.refundId === providerRefundId,
      )
    ) {
      const factLeft =
        (evidence ? Number(evidence.amountIdr) : Number(intent.amountIdr)) -
        recorded.reduce((sum, row) => sum + Number(row.amountIdr), 0);
      if (amountIdr > factLeft) {
        // A hold resolve answers 422 itself (nothing on record) and rolls back.
        if (!input.holdResolve)
          await fileExceedsLeftHold(amountIdr, intent.outletId);
        return { status: "duplicate" };
      }
    }
  }

  // 4. The insert decides the winner; a replay or a racing second path stops.
  // legend-9uvvu: a credit apply holds the deposit-intent lock shared; wait for
  // it (exclusive, after the intent row lock, as a refund does) so the net and
  // the credit used below are read after it committed.
  await lockDepositIntentsExclusive(tx, tenantId, intent.id);
  const createdAt = await lockIntentsForFact(tx, tenantId, [intent.id], now);
  const [inserted] = await tx
    .insert(paymentProviderRefunds)
    .values({
      tenantId,
      outletId: intent.outletId,
      paymentIntentId: intent.id,
      evidenceId,
      provider: PROVIDER,
      refundIdKind,
      providerRefundId,
      providerPaymentRef,
      amountIdr: idr(amountIdr),
      source: input.source,
      // legend-tlm3h: the auto journals judge a provider refund at this
      // instant, in (created_at, id) order. It comes from the fact clock of the
      // intent (lockIntentsForFact, under the intent lock taken above): strictly
      // after the latest refund of ours or of the provider recorded for it. So
      // on one intent a refund committed later is stamped later; the moment is
      // not the commit moment (the clock may be ahead of it), only their order.
      createdAt,
    })
    .onConflictDoNothing({
      target: [
        paymentProviderRefunds.tenantId,
        paymentProviderRefunds.provider,
        paymentProviderRefunds.refundIdKind,
        paymentProviderRefunds.providerRefundId,
      ],
    })
    .returning({ id: paymentProviderRefunds.id });
  if (!inserted) {
    // This very provider refund id is on record (counted with `force` while a
    // refund of ours was in flight, legend-d7im9): with nothing of ours in
    // flight now, its hold is closed. Only a provider id: its row is the
    // report's own amount. A `synthetic_full` row may have counted a refund of
    // ours that failed since, so its hold stays for finance to top up.
    // 1045 A4: only a row of this very intent (and tenant) is its fact; the
    // same id booked on another intent closes nothing here. 1055 G2: nor on
    // another transaction of this intent (the reports disagree on whose
    // refund it is: the hold stays for finance).
    if (refundIdKind === "provider") {
      const [existing] = await tx
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
        )
        .limit(1);
      if (existing) {
        if (!inFlight) await closeLiveOwnHold();
      } else if (!input.holdResolve) {
        // 1055 G2 (AP2-2): the id is on record, but not for this transaction
        // (and intent): whose refund it is stays for finance, and this
        // transaction's money is held. A hold resolve answers 409 itself.
        await fileTransactionConflictHold(amountIdr, intent.outletId);
      }
    }
    return { status: "duplicate" };
  }

  // Credit already moved to sessions (closed ones too) may now exceed the
  // intent's net: flag it in this same transaction (legend-svwdz, 1020).
  await flagCreditReconForIntent(tx, tenantId, intent.id);
  // 6. A parked fund of this transaction: the whole fund is blocked (restrict
  // when in doubt; a partial refund of a fund is not tracked). When the
  // refunded transaction is the intent's own, a fund with no evidence mapping
  // of the intent may hold that money too, so it is blocked as well.
  const ownTransaction = intent.providerRef === providerPaymentRef;
  // Already told (958, an earlier refund of this transaction): the intent of
  // the transaction, or its fund, carried the refunded stamp before this call.
  const [fundAlreadyStamped] = evidenceId
    ? await tx
        .select({ id: paymentUnallocatedFunds.id })
        .from(paymentUnallocatedFunds)
        .where(
          and(
            eq(paymentUnallocatedFunds.tenantId, tenantId),
            eq(paymentUnallocatedFunds.evidenceId, evidenceId),
            isNotNull(paymentUnallocatedFunds.providerRefundedAt),
          ),
        )
        .limit(1)
    : [];
  const alreadyAlerted =
    !!fundAlreadyStamped ||
    (ownTransaction &&
      (intent.providerRefundedAfterPaidAt !== null ||
        intent.providerRefundedAt !== null));
  const marked = await tx
    .update(paymentUnallocatedFunds)
    .set({ providerRefundedAt: now })
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        isNull(paymentUnallocatedFunds.providerRefundedAt),
        or(
          evidenceId
            ? eq(paymentUnallocatedFunds.evidenceId, evidenceId)
            : sql`false`,
          ownTransaction
            ? and(
                eq(paymentUnallocatedFunds.paymentIntentId, intent.id),
                isNull(paymentUnallocatedFunds.evidenceId),
              )
            : sql`false`,
        ),
      ),
    )
    .returning({ id: paymentUnallocatedFunds.id });
  const fundsMarked = marked.length;

  // 7. What the provider returned in total now covers what the bill paid: the
  // settled intent is flagged like a full refund (958), without a second alert.
  const [totals] = (
    await tx.execute(sql`SELECT
      ${providerRefundedForeignIdrSql(sql`${tenantId}::uuid`, sql`${intent.id}::uuid`)}::text AS cumulative,
      least(${intent.amountIdr}::bigint, greatest(
        coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
          WHERE e.tenant_id = ${tenantId}::uuid AND e.payment_intent_id = ${intent.id}::uuid), 0)
        - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
          WHERE f.tenant_id = ${tenantId}::uuid AND f.payment_intent_id = ${intent.id}::uuid), 0),
        0))::text AS paid`)
  ).rows;
  const cumulativeIdr = Number(totals?.cumulative ?? 0);
  const paidIdr = Number(totals?.paid ?? 0);
  let intentFlagged = false;
  // What our own live refunds already reserved plus the provider's refunds no
  // longer fit in what the bill may refund (the cap), so the settled intent is
  // flagged like a full refund. Read under the intent lock.
  const balance = await refundableBalance(tx, intent, { lockDeposit: false });
  if (
    (paidIdr > 0 && cumulativeIdr >= paidIdr) ||
    balance.reserved > balance.cap
  ) {
    const flagged = await tx
      .update(paymentIntents)
      .set({ providerRefundedAfterPaidAt: now })
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, intent.id),
          isNull(paymentIntents.providerRefundedAfterPaidAt),
        ),
      )
      .returning({ id: paymentIntents.id });
    intentFlagged = flagged.length > 0;
  }
  // The provider returned the whole amount of a code that is not settled: a
  // late `paid` message for it must never settle it (same as
  // `markProviderRefunded`).
  if (cumulativeIdr >= Number(intent.amountIdr))
    await tx
      .update(paymentIntents)
      .set({ providerRefundedAt: now })
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, intent.id),
          isNull(paymentIntents.providerRefundedAt),
          inArray(paymentIntents.status, ["pending", "expired", "failed"]),
        ),
      );

  // legend-ua9ja: credit used beyond what the DP still holds is held for
  // finance (refunds and payouts of the intent stop) and told once. The hold is
  // deduplicated by its own hash (webhook event id), with no provider refund
  // id: the unique key (tenant, intent, provider refund id) also counts holds
  // already closed and the live-own hold of this call. Only the winner of the
  // provider refund insert gets here, so a replay adds none. Nothing used is
  // cut and no credit is added. Worked out after step 7, which may flag the
  // intent as refunded after paid and so empty the pool.
  const creditSurplus = await creditUsedSurplusForIntent(
    tx,
    tenantId,
    intent.id,
  );
  if (creditSurplus > 0n) {
    const hex = createHash("sha256")
      .update(
        `refund_recon_hold.credit_used\0${tenantId}\0${intent.id.toLowerCase()}\0${refundKey}`,
      )
      .digest("hex");
    const [creditHold] = await tx
      .insert(refundReconHolds)
      .values({
        tenantId,
        paymentIntentId: intent.id,
        webhookEventId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
        providerRefundId: null,
        providerPaymentRef,
        amountIdr: idr(Number(creditSurplus)),
        reason: "credit_used_before_provider_refund",
        flaggedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
    if (creditHold)
      await alertCreditUsedBeforeProviderRefund(
        tx,
        context,
        {
          intentId: intent.id,
          outletId: intent.outletId,
          providerRefundId: refundKey,
          amountIdr: Number(creditSurplus),
        },
        now,
      );
  }

  // 5. One audit row and one alert for this refund (we won the insert).
  if (!input.quiet)
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: intent.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.provider_refunded_partial",
        objectType: "payment_intent",
        objectId: intent.id,
        reason: null,
        maskedChanges: {
          before: { status: intent.status },
          after: {
            status: intent.status,
            intentId: intent.id,
            evidenceId,
            providerRefundId,
            refundIdKind,
            amountIdr,
            cumulativeIdr,
            paidIdr,
            fundCount: fundsMarked,
            intentFlagged,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      [
        "status",
        "intentId",
        "evidenceId",
        "providerRefundId",
        "refundIdKind",
        "amountIdr",
        "cumulativeIdr",
        "paidIdr",
        "fundCount",
        "intentFlagged",
      ],
    );
  // The supervisors were already told this money went back (the audit row
  // above still records the refund), unless this refund newly flags the whole
  // intent: that is news they must get.
  if (!input.quiet && (!alreadyAlerted || intentFlagged))
    await alertProviderPartialRefund(
      tx,
      context,
      {
        intentId: intent.id,
        outletId: intent.outletId,
        providerRefundId: refundKey,
        amountIdr,
        cumulativeIdr,
      },
      now,
    );
  // The books were written counting a refund of ours that is not final: if it
  // later fails the journal is short. Held until finance checks (the intent's
  // refunds and payouts stop), finance told once.
  if (countedLiveOwn) await fileLiveOwnHold(amountIdr, intent.outletId);
  // legend-d7im9 (1045): no refund of ours is in flight any more and this
  // report is now counted, so the hold an earlier "retry" of the same report
  // filed is closed here (same key; holds of other reports are not touched).
  else if (!inFlight) await closeLiveOwnHold();
  // 8. The journal of this refund (legend-tlm3h): one event per recorded row.
  await appendPaymentEvent(tx, context, {
    name: "payment.provider_refunded",
    aggregateId: inserted.id,
    outletId: intent.outletId,
    actor: { type: "system" },
    payload: {
      providerRefundId: inserted.id,
      paymentIntentId: intent.id,
      amountIdr,
      refundedAt: now.toISOString(),
    },
    now,
  });
  return { status: "recorded" };
}
