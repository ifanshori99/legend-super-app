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
// already return. Nothing here touches a journal.
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
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { recordAudit } from "./core-audit.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { alertProviderPartialRefund } from "./payment-provider-refunded-alert.ts";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";
import { flagCreditReconForIntent } from "./reservation-deposit-credit.ts";
import type { Tx } from "./permission-resolver.ts";

const PROVIDER = "doit";
/** Id prefix of the refund derived from a payment's own `refunded` status. */
const SYNTHETIC_PREFIX = "payment:";

export type ProviderRefundInput = {
  provider: string;
  /** The provider's own refund id (never ours). */
  providerRefundId: string;
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
  const { providerRefundId, providerPaymentRef } = input;
  let amountIdr = input.amountIdr;
  if (
    input.provider !== PROVIDER ||
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
  // failed refund of ours returned nothing, so it never matches.
  const [own] = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.providerRef, providerRefundId),
        sql`${paymentRefunds.status} <> 'failed'`,
      ),
    )
    .limit(1);
  if (own) return { status: "own" };
  // A refund of this intent we may have sent whose provider reference we do
  // not know yet: this message may be its echo, so count nothing for now.
  const [inFlight] = await tx
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
    )
    .limit(1);
  if (inFlight && !input.force) return { status: "retry" };

  // One transaction, one refund: the payment's own `refunded` status
  // (`payment:<ref>`, the whole transaction) and a provider refund id of the
  // same transaction describe the same money, so the second never adds to it.
  const recorded = await tx
    .select({
      refundId: paymentProviderRefunds.providerRefundId,
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
  if (providerRefundId.startsWith(SYNTHETIC_PREFIX)) {
    if (evidence) {
      const left =
        Number(evidence.amountIdr) -
        recorded.reduce((sum, row) => sum + Number(row.amountIdr), 0);
      if (left <= 0) return { status: "duplicate" };
      amountIdr = left;
    }
  } else if (recorded.some((row) => row.refundId.startsWith(SYNTHETIC_PREFIX)))
    return { status: "duplicate" };

  // 4. The insert decides the winner; a replay or a racing second path stops.
  const [inserted] = await tx
    .insert(paymentProviderRefunds)
    .values({
      tenantId,
      outletId: intent.outletId,
      paymentIntentId: intent.id,
      evidenceId,
      provider: PROVIDER,
      providerRefundId,
      providerPaymentRef,
      amountIdr: idr(amountIdr),
      source: input.source,
    })
    .onConflictDoNothing({
      target: [
        paymentProviderRefunds.tenantId,
        paymentProviderRefunds.provider,
        paymentProviderRefunds.providerRefundId,
      ],
    })
    .returning({ id: paymentProviderRefunds.id });
  if (!inserted) return { status: "duplicate" };

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

  // 5. One audit row and one alert for this refund (we won the insert).
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
  if (!alreadyAlerted || intentFlagged)
    await alertProviderPartialRefund(
      tx,
      context,
      {
        intentId: intent.id,
        outletId: intent.outletId,
        providerRefundId,
        amountIdr,
        cumulativeIdr,
      },
      now,
    );
  return { status: "recorded" };
}
