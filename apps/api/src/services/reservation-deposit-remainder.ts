// Founder Q82: a DP remainder is a liability, with a single disposition.
// Reclassifying customer_deposit into its customer subledger creates no GL
// movement: receipt, subsequent sale and eventual payer refund book the money.
import {
  assertOutletInScope,
  idr,
  type OutletId,
  type ScopedTenantContext,
  uuidToUlid,
} from "@starter/shared/core";
import { and, eq, sql } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  reservationCustomerCreditUses,
  reservationDepositRemainders,
  tableSessions,
  paymentIntents,
  reservations,
} from "../db/schema/index.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertPermission,
  auditReservation,
  claimIdempotencyKey,
  MANAGE_PERMISSION,
  VIEW_PERMISSION,
  storeIdempotencyResult,
  type Tx,
} from "./reservation-core.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  depositPrincipalReservedSql,
  listSessionDepositSources,
  sessionDepositCredit,
} from "./reservation-deposit-credit.ts";
import { requestFingerprint } from "./reservation-plan.ts";
import { lockSessionDeposit } from "./qr-order-ports.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { assertNoActiveQrisHold } from "./pos-qris-hold.ts";
import {
  backingStateOf,
  postedIntentReceiptCreditOf,
} from "./accounting-auto-journal-guards.ts";
import { receiptKeyOf } from "./accounting-auto-journal-amounts.ts";

/** Current disposition, with payer-refundable money derived from WS-05. */
export async function getReservationDepositRemainders(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
): Promise<
  {
    paymentIntentId: string;
    method: string;
    amountIdr: number;
    customerCreditIdr: number;
    refundableIdr: number;
    kind: "customer_credit" | "manual_refund";
  }[]
> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await assertPermission(tx, context, actorUserId, VIEW_PERMISSION, {
      type: "outlet",
      id: outletId,
    });
    const [reservation] = await tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.outletId, outletId),
          eq(reservations.id, reservationId),
        ),
      );
    if (!reservation)
      throw new HttpError(404, "NOT_FOUND", "Reservasi tidak ditemukan.");
    const rows = await tx
      .select()
      .from(reservationDepositRemainders)
      .where(
        and(
          eq(reservationDepositRemainders.tenantId, tenantId),
          eq(reservationDepositRemainders.outletId, outletId),
          eq(reservationDepositRemainders.reservationId, reservationId),
        ),
      )
      .orderBy(
        reservationDepositRemainders.createdAt,
        reservationDepositRemainders.id,
      );
    const result: {
      paymentIntentId: string;
      method: string;
      amountIdr: number;
      customerCreditIdr: number;
      refundableIdr: number;
      kind: "customer_credit" | "manual_refund";
    }[] = [];
    for (const row of rows) {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, tenantId),
            eq(paymentIntents.outletId, outletId),
            eq(paymentIntents.id, row.paymentIntentId),
          ),
        );
      if (!intent)
        throw new HttpError(
          409,
          "CONFLICT",
          "Sumber pembayaran DP tidak ditemukan.",
        );
      let refundableIdr = 0;
      if (row.kind === "manual_refund") {
        const { cap, reserved } = await refundableBalance(tx, intent, {
          lockDeposit: false,
        });
        let available = cap > reserved ? cap - reserved : 0n;
        // Several metadata rows must not each display the same intent balance.
        const siblings = await tx
          .select()
          .from(reservationDepositRemainders)
          .where(
            and(
              eq(reservationDepositRemainders.tenantId, tenantId),
              eq(reservationDepositRemainders.outletId, outletId),
              eq(reservationDepositRemainders.paymentIntentId, intent.id),
              eq(reservationDepositRemainders.kind, "manual_refund"),
            ),
          )
          .orderBy(
            reservationDepositRemainders.createdAt,
            reservationDepositRemainders.id,
          );
        for (const sibling of siblings) {
          const share =
            BigInt(sibling.amountIdr) < available
              ? BigInt(sibling.amountIdr)
              : available;
          if (sibling.id === row.id) {
            refundableIdr = Number(share);
            break;
          }
          available -= share;
        }
      }
      result.push({
        paymentIntentId: intent.id,
        method: intent.method,
        amountIdr: Number(row.amountIdr),
        customerCreditIdr:
          row.kind === "customer_credit" ? Number(row.remainingIdr) : 0,
        refundableIdr,
        kind: row.kind,
      });
    }
    return result;
  });
}

/** The same shared intent locks as a bill read; excludes every payer refund. */
async function lockSources(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
) {
  const sources = await listSessionDepositSources(
    tx,
    context.tenant.tenantId,
    sessionId,
  );
  for (const { paymentIntentId } of sources)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`deposit-intent:${context.tenant.tenantId}:${paymentIntentId.toLowerCase()}`},0))`,
    );
}

/** Called in the session-close transaction, after its final bill is verified. */
export async function finalizeReservationDepositRemainders(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    tableSessionId: string;
    validFinalBill: boolean;
    actorUserId: string;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await lockSources(tx, context, input.tableSessionId);
  const bill = await tx.execute(sql`
    SELECT count(*)::int AS count,
      count(DISTINCT customer_profile_id)::int AS profiles,
      min(customer_profile_id::text) AS profile_id,
      greatest(coalesce(sum(o.deposit_applied_idr),0),
        coalesce(sum(o.total_idr),0) - coalesce(sum(l.paid_idr),0)
        - coalesce(sum(t.captured),0),0)::text AS used
    FROM orders o
    LEFT JOIN payment_links l ON l.tenant_id=o.tenant_id AND l.id=o.payment_link_id
    LEFT JOIN LATERAL (SELECT coalesce(sum(amount_idr),0) AS captured
      FROM pos_order_tenders pt WHERE pt.tenant_id=o.tenant_id AND pt.order_id=o.id
        AND pt.status='captured') t ON true
    WHERE o.tenant_id=${tenantId} AND o.table_session_id=${input.tableSessionId}::uuid
      AND o.status<>'voided'
  `);
  const facts = bill.rows[0]!;
  let used = BigInt(String(facts.used ?? "0"));
  // A returned DP belongs to its payer; it can never reappear as free credit.
  const releases =
    await tx.execute(sql`SELECT coalesce(sum(r.amount_idr),0)::text AS amount
    FROM pos_deposit_refunds r JOIN orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id
    WHERE r.tenant_id=${tenantId} AND o.table_session_id=${input.tableSessionId}::uuid`);
  const released = BigInt(String(releases.rows[0]?.amount ?? "0"));
  used = used > released ? used - released : 0n;
  const allocations = await tx.execute(sql`
    SELECT a.reservation_id::text, a.outlet_id::text, a.payment_intent_id::text,
      r.customer_profile_id::text, r.source::text AS source,
      least(a.amount_idr,greatest(least(r.deposit_idr,i.amount_idr,
        greatest(coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
          WHERE e.tenant_id=a.tenant_id AND e.payment_intent_id=i.id),0)
          - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
          WHERE f.tenant_id=a.tenant_id AND f.payment_intent_id=i.id),0),0))
        - ${depositPrincipalReservedSql(sql`a.tenant_id`, sql`i.id`)},0))::text AS held
    FROM reservation_deposit_allocations a
    JOIN reservations r ON r.tenant_id=a.tenant_id AND r.id=a.reservation_id
    JOIN payment_intents i ON i.tenant_id=a.tenant_id AND i.id=a.payment_intent_id
    WHERE a.tenant_id=${tenantId} AND a.table_session_id=${input.tableSessionId}::uuid
      AND i.status IN ('paid','partially_refunded') AND i.paid_at IS NOT NULL
    ORDER BY a.payment_intent_id
  `);
  for (const allocation of allocations.rows) {
    const held = BigInt(String(allocation.held));
    const consumed = used < held ? used : held;
    used -= consumed;
    const remainder = held - consumed;
    if (remainder <= 0n) continue;
    // A profile linked from a public booking comes from an unverified phone
    // number, so it is never trusted to receive credit.
    const bookingProfile =
      allocation.customer_profile_id && allocation.source !== "website"
        ? String(allocation.customer_profile_id)
        : null;
    const billProfile =
      Number(facts.profiles) === 1 ? String(facts.profile_id) : null;
    const candidate = bookingProfile ?? billProfile;
    // A mixed bill never silently credits one of its customers.
    const consistent =
      Number(facts.profiles) <= 1 &&
      (!bookingProfile || !billProfile || bookingProfile === billProfile);
    const profiles = candidate
      ? await tx.execute(sql`SELECT id FROM customer_profiles
      WHERE tenant_id=${tenantId} AND id=${candidate}::uuid
        AND membership_status='active' AND whatsapp_verified_at IS NOT NULL
        AND merged_into_profile_id IS NULL FOR SHARE`)
      : { rows: [] };
    const customerProfileId = profiles.rows.length === 1 ? candidate : null;
    const kind =
      input.validFinalBill &&
      Number(facts.count) > 0 &&
      consistent &&
      customerProfileId
        ? ("customer_credit" as const)
        : ("manual_refund" as const);
    const [inserted] = await tx
      .insert(reservationDepositRemainders)
      .values({
        tenantId,
        outletId: String(allocation.outlet_id) as OutletId,
        reservationId: String(allocation.reservation_id),
        tableSessionId: input.tableSessionId,
        paymentIntentId: String(allocation.payment_intent_id),
        customerProfileId,
        amountIdr: idr(Number(remainder)),
        remainingIdr: idr(Number(remainder)),
        kind,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted)
      await auditReservation(tx, context, {
        actorUserId: input.actorUserId,
        outletId: inserted.outletId,
        action: "reservation.deposit_remainder",
        reservationId: inserted.reservationId,
        reason: kind,
        before: {},
        after: { amountIdr: inserted.amountIdr, kind, customerProfileId },
        now: input.now,
      });
  }
  // Credit allocated to a subsequent session is not a new receipt. Return its
  // unused part to the SAME ledger row, never mint a second remainder.
  const uses = await tx
    .select()
    .from(reservationCustomerCreditUses)
    .where(
      and(
        eq(reservationCustomerCreditUses.tenantId, tenantId),
        eq(reservationCustomerCreditUses.tableSessionId, input.tableSessionId),
      ),
    )
    .orderBy(reservationCustomerCreditUses.remainderId)
    .for("update");
  const creditReturns =
    await tx.execute(sql`SELECT p.payment_intent_id::text AS intent_id,
    coalesce(sum(p.amount_idr),0)::text AS amount
    FROM pos_deposit_refunds p JOIN orders o ON o.tenant_id=p.tenant_id AND o.id=p.order_id
    WHERE p.tenant_id=${tenantId} AND o.table_session_id=${input.tableSessionId}::uuid
    GROUP BY p.payment_intent_id`);
  const returnsByIntent = new Map(
    creditReturns.rows.map((row) => [
      String(row.intent_id),
      BigInt(String(row.amount)),
    ]),
  );
  for (const use of uses) {
    const [source] = await tx
      .select({ intentId: reservationDepositRemainders.paymentIntentId })
      .from(reservationDepositRemainders)
      .where(
        and(
          eq(reservationDepositRemainders.tenantId, tenantId),
          eq(reservationDepositRemainders.id, use.remainderId),
        ),
      );
    if (!source)
      throw new HttpError(
        409,
        "CONFLICT",
        "Sumber saldo pelanggan tidak ditemukan.",
      );
    const gross = BigInt(use.amountIdr) - BigInt(use.returnedIdr);
    const released = returnsByIntent.get(source.intentId) ?? 0n;
    const returnedToPayer = released < gross ? released : gross;
    returnsByIntent.set(source.intentId, released - returnedToPayer);
    // A Q81 return belongs to the original payer, never both that payer and
    // the customer's spendable balance when this bill ends.
    const amount = gross - returnedToPayer;
    const consumed = used < amount ? used : amount;
    used -= consumed;
    const returned = amount - consumed;
    if (returned <= 0n) continue;
    await tx
      .update(reservationDepositRemainders)
      .set({
        remainingIdr: sql`${reservationDepositRemainders.remainingIdr}+${returned.toString()}::bigint`,
      })
      .where(
        and(
          eq(reservationDepositRemainders.tenantId, tenantId),
          eq(reservationDepositRemainders.id, use.remainderId),
        ),
      );
    await tx
      .update(reservationCustomerCreditUses)
      .set({ returnedIdr: idr(Number(BigInt(use.returnedIdr) + returned)) })
      .where(
        and(
          eq(reservationCustomerCreditUses.tenantId, tenantId),
          eq(reservationCustomerCreditUses.id, use.id),
        ),
      );
  }
}

/** Assign an existing liability to a new bill; no second receipt is created. */
export async function applyReservationCustomerCredit(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  input: {
    customerProfileId: string;
    tableSessionId: string;
    amountIdr: number;
  },
  idempotencyKey: string,
  now = new Date(),
): Promise<{ amountIdr: number; tableSessionId: string }> {
  assertOutletInScope(context.outletScope, outletId);
  const unavailable = () =>
    new HttpError(
      409,
      "CUSTOMER_CREDIT_NOT_AVAILABLE",
      "Saldo pelanggan tidak tersedia untuk tagihan ini.",
    );
  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr <= 0)
    throw unavailable();
  const fingerprint = requestFingerprint("reservation.credit.apply", {
    outletId,
    ...input,
  });
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
      type: "outlet",
      id: outletId,
    });
    const claim = await claimIdempotencyKey(tx, context, {
      outletId,
      key: idempotencyKey,
      operation: "reservation.credit.apply",
      fingerprint,
    });
    if (claim.kind === "replay") {
      if (
        claim.response.amountIdr !== input.amountIdr ||
        claim.response.tableSessionId !== input.tableSessionId
      )
        throw unavailable();
      return {
        amountIdr: input.amountIdr,
        tableSessionId: input.tableSessionId,
      };
    }
    const [session] = await tx
      .select()
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.outletId, outletId),
          eq(tableSessions.id, input.tableSessionId),
        ),
      )
      .for("update");
    if (!session || !["open", "bill_requested"].includes(session.status))
      throw unavailable();
    // legend-yhia9 D-01: credit changes what is left to pay, so it is refused
    // while any bill of the session has a QR that can still be paid. POS DP
    // return and refund approval lock orders, then pos_orders, then the
    // deposit-intent lock; this path must take them in that same order, so the
    // guard runs here, before any advisory lock (else deadlock 40P01).
    const billOrders = await tx.execute(sql`SELECT id::text AS id FROM orders
      WHERE tenant_id=${tenantId} AND table_session_id=${session.id}::uuid
      ORDER BY id FOR UPDATE`);
    await tx.execute(sql`SELECT order_id FROM pos_orders
      WHERE tenant_id=${tenantId} AND order_id IN (SELECT id FROM orders
        WHERE tenant_id=${tenantId} AND table_session_id=${session.id}::uuid)
      ORDER BY order_id FOR UPDATE`);
    for (const row of billOrders.rows)
      await assertNoActiveQrisHold(tx, context, uuidToUlid(String(row.id)));
    // Every apply for this customer is serialized before source rows are read.
    // Refunds use exclusive intent locks; shared locks must precede ledger
    // row locks, and never be followed by an intent row lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reservation-credit:${tenantId}:${input.customerProfileId.toLowerCase()}`},0))`,
    );
    const candidates = await tx
      .select()
      .from(reservationDepositRemainders)
      .where(
        and(
          eq(reservationDepositRemainders.tenantId, tenantId),
          eq(reservationDepositRemainders.outletId, outletId),
          eq(
            reservationDepositRemainders.customerProfileId,
            input.customerProfileId,
          ),
          eq(reservationDepositRemainders.kind, "customer_credit"),
          sql`${reservationDepositRemainders.remainingIdr}>0`,
        ),
      )
      .orderBy(
        reservationDepositRemainders.paymentIntentId,
        reservationDepositRemainders.id,
      );
    if (candidates.length === 0) throw unavailable();
    const targetSources = await listSessionDepositSources(
      tx,
      tenantId,
      session.id,
    );
    const intentIds = [
      ...new Set([
        ...candidates.map((r) => r.paymentIntentId),
        ...targetSources.map((r) => r.paymentIntentId),
      ]),
    ].sort();
    for (const intentId of intentIds)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`deposit-intent:${tenantId}:${intentId.toLowerCase()}`},0))`,
      );
    // Unlink/re-link updates this profile row. Keep verified ownership stable
    // through the transfer, before locking credit rows (identity merge takes
    // the profile before rewriting its ledger references too).
    const profile =
      await tx.execute(sql`SELECT id FROM customer_profiles WHERE tenant_id=${tenantId}
      AND id=${input.customerProfileId}::uuid AND membership_status='active'
      AND whatsapp_verified_at IS NOT NULL AND merged_into_profile_id IS NULL FOR SHARE`);
    if (profile.rows.length !== 1) throw unavailable();
    const credits = await tx
      .select()
      .from(reservationDepositRemainders)
      .where(
        and(
          eq(reservationDepositRemainders.tenantId, tenantId),
          eq(reservationDepositRemainders.outletId, outletId),
          eq(
            reservationDepositRemainders.customerProfileId,
            input.customerProfileId,
          ),
          eq(reservationDepositRemainders.kind, "customer_credit"),
          sql`${reservationDepositRemainders.remainingIdr}>0`,
        ),
      )
      .orderBy(
        reservationDepositRemainders.paymentIntentId,
        reservationDepositRemainders.id,
      )
      .for("update");
    // V1 stays in the source outlet, so entity and payer-refund routing cannot
    // change. Both original and destination outlet rows must still exist.
    const entity =
      await tx.execute(sql`SELECT legal_entity_id FROM outlets WHERE tenant_id=${tenantId}
      AND id=${outletId}::uuid AND legal_entity_id IS NOT NULL`);
    if (entity.rows.length !== 1) throw unavailable();
    for (const intentId of intentIds) {
      const [source] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, tenantId),
            eq(paymentIntents.id, intentId),
            eq(paymentIntents.outletId, outletId),
            sql`${paymentIntents.status} IN ('paid','partially_refunded')`,
            sql`${paymentIntents.paidAt} IS NOT NULL`,
          ),
        );
      if (!source) throw unavailable();
      // Finance reversals lock the original entry FOR UPDATE. Hold its SHARE
      // lock through this transfer, then inspect its net booked credit.
      const receipts =
        await tx.execute(sql`SELECT legal_entity_id FROM journal_entries
        WHERE tenant_id=${tenantId} AND idempotency_key=${receiptKeyOf(intentId)} FOR SHARE`);
      if (
        receipts.rows.length !== 1 ||
        receipts.rows[0]!.legal_entity_id !== entity.rows[0]!.legal_entity_id ||
        (await backingStateOf(tx, tenantId, { kind: "intent", intentId })) !==
          "posted"
      )
        throw unavailable();
      const balance = await refundableBalance(tx, source, {
        lockDeposit: false,
      });
      const held =
        balance.depositInUse +
        balance.forfeited +
        balance.posSaleInUse +
        balance.qrSaleInUse +
        balance.chargeInUse;
      if (
        held + balance.reserved > balance.paid ||
        (await postedIntentReceiptCreditOf(tx, tenantId, intentId)) <
          balance.paid
      )
        throw unavailable();
    }
    await lockSessionDeposit(tx, tenantId, session.id);
    const bill = await tx.execute(sql`SELECT count(*)::int AS count,
      count(customer_profile_id)::int AS linked,count(DISTINCT customer_profile_id)::int AS profiles,
      min(customer_profile_id::text) AS profile,
      greatest(coalesce(sum(o.total_idr),0)-coalesce(sum(l.paid_idr),0)-coalesce(sum(t.captured),0),0)::text AS outstanding
      FROM orders o LEFT JOIN payment_links l ON l.tenant_id=o.tenant_id AND l.id=o.payment_link_id
      LEFT JOIN LATERAL (SELECT coalesce(sum(pt.amount_idr),0) AS captured FROM pos_order_tenders pt
        WHERE pt.tenant_id=o.tenant_id AND pt.order_id=o.id AND pt.status='captured') t ON true
      WHERE o.tenant_id=${tenantId} AND o.table_session_id=${session.id}::uuid AND o.status<>'voided'`);
    const facts = bill.rows[0]!;
    if (
      Number(facts.count) === 0 ||
      facts.count !== facts.linked ||
      Number(facts.profiles) !== 1 ||
      facts.profile !== input.customerProfileId
    )
      throw unavailable();
    const available = credits.reduce(
      (sum, row) => sum + Number(row.remainingIdr),
      0,
    );
    const assigned = await sessionDepositCredit(tx, tenantId, session.id);
    if (
      input.amountIdr > available ||
      input.amountIdr > Math.max(0, Number(facts.outstanding) - assigned)
    )
      throw unavailable();
    let left = input.amountIdr;
    let sourceReservationId: string | null = null;
    for (const credit of credits) {
      if (left <= 0) break;
      const amount = Math.min(left, Number(credit.remainingIdr));
      if (amount <= 0) continue;
      await tx
        .update(reservationDepositRemainders)
        .set({ remainingIdr: idr(Number(credit.remainingIdr) - amount) })
        .where(
          and(
            eq(reservationDepositRemainders.tenantId, tenantId),
            eq(reservationDepositRemainders.id, credit.id),
          ),
        );
      await tx.insert(reservationCustomerCreditUses).values({
        tenantId,
        outletId,
        remainderId: credit.id,
        tableSessionId: session.id,
        amountIdr: idr(amount),
        returnedIdr: idr(0),
        idempotencyKey,
        createdAt: now,
      });
      sourceReservationId ??= credit.reservationId;
      left -= amount;
      await auditReservation(tx, context, {
        actorUserId,
        outletId,
        action: "reservation.customer_credit_applied",
        reservationId: credit.reservationId,
        reason: null,
        before: { remainingIdr: credit.remainingIdr },
        after: maskAuditChanges({
          remainingIdr: Number(credit.remainingIdr) - amount,
          amountIdr: amount,
          tableSessionId: session.id,
        }) as Record<string, unknown>,
        now,
      });
    }
    if (left !== 0 || !sourceReservationId) throw unavailable();
    const response = { amountIdr: input.amountIdr, tableSessionId: session.id };
    await storeIdempotencyResult(
      tx,
      context,
      idempotencyKey,
      sourceReservationId,
      response,
    );
    return response;
  });
}
