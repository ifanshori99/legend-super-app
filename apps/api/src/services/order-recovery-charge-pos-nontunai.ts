// The cashier takes a dearer-swap charge at the till with QRIS or an EDC card
// (legend-gt98h); cash lives in order-recovery-charge-pos.ts (legend-800h1).
// Same preamble as the cash collect: ONE transaction, lock order issue, order,
// charge (`lockChargeChain`), the charge's link, then the cashier's shift.
//
// - QRIS: the charge keeps its status. The cashier gets ONE live QRIS code on
//   the charge's own link (`oic:<chargeId>`, the guest's link when it exists,
//   else opened here); the intent is stored on `payment_intent_id`. The charge
//   is marked paid ONLY by `dispatchIssueChargePaid` once the gateway confirms
//   (verified webhook), exactly as a guest payment. A retry (same or another
//   key) while that code is pending returns it; an expired or failed code
//   opens a new one. Nothing is written to the drawer.
// - EDC card: settles only on an APPROVED `edc_transactions` ecr sale whose
//   reference is the charge id and whose amount is the charge amount (the EDC
//   agent wrote it; see pos-edc-tender.ts). Pending / unknown / declined /
//   failed / cancelled leave the charge open (409). One approval, one charge:
//   the reference binds the sale to this charge, the charge row lock lets one
//   request mark it paid, and the sale's own unique index rejects a second
//   approval of the reference. The sale id is the idempotency identity:
//   offering the same sale again for a charge it paid answers the same result.
//   No cash_in; the `order_issue.charge_paid` event says `pos_edc`.
// - A pending guest or POS code is cancelled when an EDC sale paid the charge
//   (the bank already holds the money); a QRIS already paid on that link
//   refuses the EDC with 409 (a human refunds one of the two).

import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { CollectChargeAtPosInput } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { paymentIntents, paymentLinks } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import {
  appendChargePaidEvent,
  auditCharge,
  AUDIT_PAID,
  chargeAudit,
  confirmChargeLinksUnpaid,
  lockChargeChain,
} from "./order-recovery-charge.ts";
import { openChargeLinkInTx } from "./order-recovery-charge-payment.ts";
import type {
  CollectChargeAtPosCaller,
  CollectedChargeAtPos,
} from "./order-recovery-charge-pos.ts";
import { assertOrderNotVoidedByCorrection } from "./order-recovery-charge-void-guard.ts";
import { toView } from "./order-recovery-charge-staff.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  cancelPaymentLinkInTx,
  createIntent,
  readIntentView,
} from "./payment.service.ts";
import { lockCashierShiftForCash } from "./pos-cash-guard.ts";
import {
  assertNoActiveQrisHold,
  HOLD_CLOSE_MARGIN_MS,
} from "./pos-qris-hold.ts";
import { chargeLinkSealAad, guestPaymentDto } from "./qr-order-payment.ts";
import { notifyQrOrderChange } from "./qr-order-realtime-signal.ts";

const PAY = "pos.payment.accept";

type QrisInput = Extract<CollectChargeAtPosInput, { method: "qris" }>;
type EdcInput = Extract<CollectChargeAtPosInput, { method: "edc_card" }>;
type Locked = NonNullable<Awaited<ReturnType<typeof lockChargeChain>>>;

/** Access, the charge chain locked, the outlet in scope. 404 / 403 otherwise. */
async function lockChargeForCashier(
  tx: Tx,
  context: ScopedTenantContext,
  caller: CollectChargeAtPosCaller,
  chargeId: string,
  now: Date,
): Promise<Locked> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    caller.userId,
    now,
  );
  const locked = await lockChargeChain(tx, context.tenant.tenantId, {
    chargeId,
  });
  if (!locked)
    throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
  assertOutletInScope(context.outletScope, locked.charge.outletId);
  if (!snapshot.allows(PAY, { type: "outlet", id: locked.charge.outletId }))
    throw new AccessError(
      "PERMISSION_DENIED",
      "Anda tidak dapat menerima pembayaran di outlet ini.",
    );
  return locked;
}

async function assertCollectable(
  tx: Tx,
  tenantId: TenantId,
  locked: Locked,
): Promise<void> {
  const { charge, order } = locked;
  if (charge.status !== "open" && charge.status !== "routed_pos")
    throw new HttpError(
      409,
      "CONFLICT",
      "Hanya tagihan selisih yang masih terbuka yang dapat dibayar di kasir.",
    );
  if (order.status === "voided")
    throw new HttpError(
      409,
      "CONFLICT",
      "Pesanan sudah dibatalkan; tagihan selisih tidak dapat dibayar.",
    );
  await assertOrderNotVoidedByCorrection(tx, tenantId, order.id);
}

/**
 * Refuses while a verified `paid` intent of the charge's link exists but the
 * charge is not yet marked (the worker applies `payment.paid` through the
 * outbox). `lockLink` (EDC, which cancels the link) locks the link first, then
 * the intent: the confirmation order. A QRIS issue must NOT lock it: the code
 * is created by `createIntent` on its own connection, which locks the link
 * and would wait on this transaction for ever; `createIntent` itself refuses
 * a link with nothing left to pay.
 */
async function assertNoPaidIntentOnLink(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string | null,
  lockLink: boolean,
): Promise<void> {
  if (paymentLinkId === null) return;
  const tenantId = context.tenant.tenantId;
  if (lockLink)
    await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, tenantId),
          eq(paymentLinks.id, paymentLinkId),
        ),
      )
      .for("update");
  const [taken] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        eq(paymentIntents.status, "paid"),
      ),
    )
    .limit(1);
  if (taken)
    throw new HttpError(
      409,
      "CONFLICT",
      "QRIS sudah dibayar; tunggu konfirmasi.",
    );
}

export async function collectChargeAtPosQris(
  context: ScopedTenantContext,
  caller: CollectChargeAtPosCaller,
  chargeId: string,
  input: QrisInput,
  now: Date,
): Promise<CollectedChargeAtPos> {
  const tenantId = context.tenant.tenantId;
  // legend-ukbq3: ask the provider first (outside the transaction). Money the
  // provider already holds is applied to the charge, so no new code is issued.
  const settled = await confirmChargeLinksUnpaid(context, { chargeId }, now);
  const checks = async (tx: Tx) => {
    const locked = await lockChargeForCashier(
      tx,
      context,
      caller,
      chargeId,
      now,
    );
    await assertCollectable(tx, tenantId, locked);
    if (settled)
      throw new HttpError(
        409,
        "CONFLICT",
        "QRIS sudah dibayar; tunggu konfirmasi.",
      );
    await assertNoPaidIntentOnLink(
      tx,
      context,
      locked.charge.paymentLinkId,
      false,
    );
    // The cashier works from an open shift on this device (SHIFT_NOT_OPEN);
    // the QRIS money never enters its drawer.
    await lockCashierShiftForCash(tx, context, {
      outletId: outletIdSchema.parse(locked.charge.outletId),
      cashierId: caller.userId,
      deviceId: caller.deviceId,
      mode: "in",
      at: now,
    });
    return locked.charge;
  };
  // Step 1 (like the guest's `ensureChargeLink`): the bill is opened and
  // committed before a code is asked of it. The guest's link is reused.
  await withTenant(db, context, async (tx) => {
    const charge = await checks(tx);
    if (charge.paymentLinkId !== null && charge.paymentLinkTokenSealed !== null)
      return;
    await openChargeLinkInTx(
      tx,
      context,
      charge,
      { tableLabel: null, pax: null },
      now,
    );
  });
  return withTenant(db, context, async (tx) => {
    const charge = await checks(tx);
    if (charge.paymentLinkTokenSealed === null)
      throw new Error("Charge payment link token missing");
    const token = openSecret(
      charge.paymentLinkTokenSealed,
      chargeLinkSealAad(tenantId, charge.id),
    );
    const target = { kind: "issue_charge", chargeId } as const;

    // One live code per charge: a pending QRIS is returned as it is.
    if (charge.paymentIntentId !== null) {
      const current = await readIntentView(
        context,
        token,
        charge.paymentIntentId,
        now,
      );
      if (
        current.status === "pending" &&
        current.instructions.method === "qris"
      )
        return {
          charge: toView(charge),
          changeIdr: 0,
          payment: guestPaymentDto(current, target),
        };
    }
    // legend-f1mmf: one live code per charge. A code of the link past its
    // expiry may still take money until its margin passed: no new code yet.
    if (charge.paymentLinkId !== null) {
      const [lapsing] = await tx
        .select({ id: paymentIntents.id })
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, tenantId),
            eq(paymentIntents.paymentLinkId, charge.paymentLinkId),
            eq(paymentIntents.status, "pending"),
            gt(
              paymentIntents.expiresAt,
              new Date(now.getTime() - HOLD_CLOSE_MARGIN_MS),
            ),
          ),
        )
        .limit(1);
      if (lapsing)
        throw new HttpError(
          409,
          "CONFLICT",
          "Kode QRIS sebelumnya baru saja kedaluwarsa; tunggu sebentar lalu cek status.",
        );
    }
    // legend-ek1wt: while a QR of the order's bill can still be paid, no new code.
    await assertNoActiveQrisHold(tx, context, charge.orderId);
    const intent = await createIntent(
      context,
      token,
      {
        method: "qris",
        channelCode: null,
        idempotencyKey: `qpc-${createHash("sha256")
          .update(`${charge.id}:${input.idempotencyKey}`)
          .digest("hex")
          .slice(0, 48)}`,
      },
      now,
      { orderLockedByCaller: true },
    );
    const [updated] = await tx
      .update(orderIssueCharges)
      .set({ paymentIntentId: intent.id, updatedAt: now })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, charge.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Charge update returned no row");
    return {
      charge: toView(updated),
      changeIdr: 0,
      payment: guestPaymentDto(intent, target),
    };
  });
}

export async function collectChargeAtPosEdc(
  context: ScopedTenantContext,
  caller: CollectChargeAtPosCaller,
  chargeId: string,
  input: EdcInput,
  now: Date,
): Promise<CollectedChargeAtPos> {
  const tenantId = context.tenant.tenantId;
  const settled = await confirmChargeLinksUnpaid(context, { chargeId }, now);
  return withTenant(db, context, async (tx) => {
    const locked = await lockChargeForCashier(
      tx,
      context,
      caller,
      chargeId,
      now,
    );
    const { charge, issue } = locked;
    // One approval, one use, even when two requests race on it.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-edc-tender:${tenantId}:${input.edcTransactionId}`}, 0))`,
    );
    const [sale] = await tx
      .select()
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.id, input.edcTransactionId),
        ),
      )
      .limit(1);
    // Same answer for "missing" and "another outlet's": no probing of ids.
    if (!sale || sale.outletId !== charge.outletId)
      throw new CoreError("NOT_FOUND", "Transaksi EDC tidak ditemukan.");

    // Replay: this approved sale already paid this charge (no cash, no code).
    if (
      charge.status === "paid" &&
      charge.cashMovementId === null &&
      charge.paymentIntentId === null &&
      sale.reference === charge.id &&
      sale.status === "approved"
    )
      return { charge: toView(charge), changeIdr: 0 };
    await assertCollectable(tx, tenantId, locked);
    if (settled)
      throw new HttpError(
        409,
        "CONFLICT",
        "QRIS sudah dibayar; tunggu konfirmasi.",
      );
    await assertNoPaidIntentOnLink(tx, context, charge.paymentLinkId, true);
    await lockCashierShiftForCash(tx, context, {
      outletId: outletIdSchema.parse(charge.outletId),
      cashierId: caller.userId,
      deviceId: caller.deviceId,
      mode: "in",
      at: now,
    });

    if (sale.type !== "sale" || sale.mode !== "ecr")
      throw new HttpError(
        409,
        "CONFLICT",
        "Hanya penjualan EDC dari terminal yang bisa dipakai sebagai pembayaran.",
      );
    if (sale.status === "pending" || sale.status === "unknown")
      throw new HttpError(
        409,
        "CONFLICT",
        "Transaksi EDC belum disetujui bank; tunggu hasil atau cek status.",
      );
    if (sale.status !== "approved")
      throw new HttpError(
        409,
        "CONFLICT",
        "Transaksi EDC ditolak, dibatalkan, atau gagal; tagihan belum dibayar.",
      );
    if (sale.needsReconciliation)
      throw new HttpError(
        409,
        "CONFLICT",
        "Transaksi EDC ini menunggu rekonsiliasi; hubungi supervisor.",
      );
    if (sale.reference !== charge.id)
      throw new HttpError(
        409,
        "CONFLICT",
        "Transaksi EDC ini milik tagihan lain.",
      );
    if (sale.method !== "card" || sale.amountIdr !== charge.amountIdr)
      throw new HttpError(
        409,
        "CONFLICT",
        "Metode atau nominal transaksi EDC tidak sama dengan tagihan selisih.",
      );

    const [updated] = await tx
      .update(orderIssueCharges)
      .set({
        status: "paid",
        paidAt: now,
        paidBy: caller.userId,
        paymentIntentId: null,
        cashMovementId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, charge.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Charge update returned no row");
    // The guest's code can no longer be paid (the bank holds the money).
    if (charge.paymentLinkId !== null)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: charge.paymentLinkId,
        now,
        reason: "issue_charge_paid_at_pos",
      });
    await appendChargePaidEvent(tx, context, {
      charge,
      intentId: null,
      edc: true,
      paidAt: now,
      at: now,
    });
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: issue.id,
      action: AUDIT_PAID,
      actorUserId: caller.userId,
      reason: "Selisih swap dibayar EDC di kasir",
      after: { ...chargeAudit(charge), status: "paid" },
      at: now,
    });
    if (charge.tableSessionId !== null)
      await notifyQrOrderChange(tx, context, {
        sessionId: charge.tableSessionId,
        orderId: charge.orderId,
        status: "sent",
      });
    return { charge: toView(updated), changeIdr: 0 };
  });
}
