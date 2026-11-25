// Settling a POS payment request whose answer never reached the till (1268 W2
// review, contract @starter/shared/pos payment-intent). No money moves here: a
// recorded request is read back, an unrecorded one is made impossible.
//
// - A known key: under the same advisory lock `posIdempotent` takes, a row of
//   that key is either what the request recorded, or we insert a tombstone
//   whose fingerprint no request can have. A late arrival waits for the lock and
//   is then refused with IDEMPOTENCY_KEY_REUSED.
// - No key (the stored request is unreadable): under the order lock, refused
//   while money may still be on its way; otherwise the order `version` moves and
//   a late arrival, whose body states the version it was made for, is stale.

import { and, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  PAYMENT_INTENT_CARD_STATEMENT_REQUIRED,
  PAYMENT_INTENT_SLIP_REQUIRED,
  resolvePosPaymentIntent as resolveContract,
  type PosOrderDetail,
  type PosPaymentIntentOutcome,
  type PosTenderResult,
} from "@starter/shared/pos";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { posOrderIdempotency } from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { outletContext } from "./device-pin-support.ts";
import type { Tx } from "./menu-internals.ts";
import { assertNoOpenFundsOfPosOrderTx } from "./pos-order-open-funds.ts";
import {
  assertNoOpenEdcRequest,
  auditPos,
  bumpPos,
  lockPosIdempotencyKey,
  lockPosOrder,
  orderDetail,
  readPosOrder,
  remainingIdr,
  sha256,
  tendersOf,
  type Locked,
  type PosCaller,
} from "./pos-order-support.ts";
import { assertNoActiveQrisHold } from "./pos-qris-hold.ts";
import { holdsOverridePermission } from "./staff-override.service.ts";
import { attemptApproverPin } from "./staff-pin-proof.service.ts";

type Input = z.infer<typeof resolveContract.body>;

/** `operation` of the row that closes a key; no request is made under it. */
const TOMBSTONE_OPERATION = "payment_intent.resolve";
type Tombstone = { orderId: string };

const assertCardStated = (stated: boolean): void => {
  if (!stated)
    throw new HttpError(
      409,
      PAYMENT_INTENT_CARD_STATEMENT_REQUIRED,
      "Supervisor wajib menyatakan kartu tidak terdebit, sudah di-void di mesin, atau mencatat pembayarannya.",
    );
};

/** As read from paper: case and dashes say nothing about which slip it is. */
const slipNumber = (value: string) => value.replaceAll("-", "").toUpperCase();

/** The bill holds money of an EDC slip with this bank reference. */
async function holdsSlip(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  bankRef: string,
): Promise<boolean> {
  const tenders = await tendersOf(tx, context, orderId);
  return tenders.some(
    (tender) =>
      tender.status === "captured" &&
      (tender.method === "edc_card" || tender.method === "edc_qris") &&
      tender.reference !== null &&
      slipNumber(tender.reference) === slipNumber(bankRef),
  );
}

/**
 * The books hold this slip: voiding it on the machine would leave the bill paid
 * and the money gone. The terminal and the amount are not compared: in doubt,
 * no void.
 */
async function assertNotVoidingRecorded(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  input: Input,
): Promise<void> {
  if (
    input.card === "voided" &&
    input.bankRef !== undefined &&
    (await holdsSlip(tx, context, orderId, input.bankRef))
  )
    throw new CoreError(
      "CONFLICT",
      "Slip ini sudah tercatat di tagihan, jangan di-void. Bila sudah telanjur, batalkan lewat koreksi.",
    );
}

/** Under the key lock: what the key recorded, or the tombstone. */
async function settleKey(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  key: string,
  input: Input,
): Promise<PosPaymentIntentOutcome> {
  const { order } = locked;
  const tenantId = context.tenant.tenantId;
  const [existing] = await tx
    .select()
    .from(posOrderIdempotency)
    .where(
      and(
        eq(posOrderIdempotency.tenantId, tenantId),
        eq(posOrderIdempotency.outletId, order.outletId),
        eq(posOrderIdempotency.key, key),
      ),
    );
  if (existing) {
    const closed = existing.operation === TOMBSTONE_OPERATION;
    const orderId = closed
      ? (existing.response as Tombstone).orderId
      : existing.operation === "order.tender"
        ? (existing.response as PosTenderResult).order.id
        : null;
    if (orderId !== order.id)
      throw new CoreError(
        "CONFLICT",
        "Kunci ini bukan permintaan pembayaran tagihan ini.",
      );
    // The books hold this money: a void on the machine goes through a correction.
    if (!closed && input.card === "voided")
      throw new CoreError(
        "CONFLICT",
        "Pembayaran ini sudah tercatat. Muat ulang tagihan dan batalkan lewat koreksi.",
      );
    return closed ? "closed" : "recorded";
  }
  if (key.startsWith("edc_standalone:"))
    assertCardStated(input.card !== undefined);
  const response: Tombstone = { orderId: order.id };
  await tx.insert(posOrderIdempotency).values({
    tenantId,
    outletId: order.outletId,
    key,
    operation: TOMBSTONE_OPERATION,
    // Every request's fingerprint is the hash of a JSON object: never this.
    fingerprint: sha256(`${TOMBSTONE_OPERATION}:${key}`),
    response,
  });
  return "closed";
}

/** Under the order lock, with no key: nothing may still be on its way. */
async function fenceOrder(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  input: Input,
  now: Date,
): Promise<{ outcome: PosPaymentIntentOutcome; locked: Locked }> {
  const { order, pos } = locked;
  await assertNoActiveQrisHold(tx, context, order.id);
  const tenders = await tendersOf(tx, context, order.id);
  if (tenders.some((tender) => tender.status === "authorized"))
    throw new CoreError(
      "CONFLICT",
      "Masih ada pembayaran yang menunggu konfirmasi untuk tagihan ini.",
    );
  await assertNoOpenFundsOfPosOrderTx(tx, context.tenant.tenantId, order);
  // A bill paid by a hand-keyed EDC slip keeps a ledger row to reconcile, which
  // the check below counts as open: paid is decided first.
  if (order.status !== "voided" && remainingIdr(order, tenders) <= 0) {
    // Paid, but with that card or on top of it? A charged card names its slip.
    assertCardStated(input.card !== undefined);
    if (input.card !== "not_debited") {
      const { bankRef } = input;
      if (bankRef === undefined)
        throw new HttpError(
          409,
          PAYMENT_INTENT_SLIP_REQUIRED,
          "Tagihan sudah lunas. Isi nomor referensi bank dari slip EDC.",
        );
      if (
        input.card === "recording" &&
        !(await holdsSlip(tx, context, order.id, bankRef))
      )
        throw new CoreError(
          "CONFLICT",
          "Slip ini tidak tercatat di tagihan. Cocokkan slip dulu; jangan void bila sudah tercatat.",
        );
    }
    return { outcome: "recorded", locked };
  }
  await assertNoOpenEdcRequest(tx, context, order);
  // The stored request may have been an EDC payment: the supervisor says what
  // became of the card before the bill can take anything.
  assertCardStated(input.card !== undefined);
  // A final order takes no tender and no change: it is its own fence.
  if (order.status === "voided" || order.status === "completed")
    return { outcome: "closed", locked };
  return {
    outcome: "fenced",
    locked: { order, pos: await bumpPos(tx, context, pos, now) },
  };
}

/**
 * POST .../payment-intents/resolve. The caller holds `pos.payment.accept` at the
 * outlet; the approver is another person who may approve the override
 * (`edc_standalone` for an EDC key or an unreadable request, else `void`) and
 * types their own PIN. Every settled request is audited with the approver and
 * the reason.
 */
export async function resolvePosPaymentIntent(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: Input,
  now = new Date(),
): Promise<{ outcome: PosPaymentIntentOutcome; order: PosOrderDetail }> {
  const { tenant } = context;
  const { key, approverUserId } = input;
  // AUTH-06: the approver is never the requester.
  if (approverUserId.toLowerCase() === caller.userId.toLowerCase())
    throw new AccessError("APPROVER_IS_REQUESTER");
  const approver = outletContext(tenant, outletId);
  const assertApprover = async (tx: Tx) => {
    if (
      !(await holdsOverridePermission(
        tx,
        tenant,
        approver,
        approverUserId,
        key === null || key.startsWith("edc_standalone:")
          ? "edc_standalone"
          : "void",
        outletId,
        now,
        // Settled only after this approver's own PIN (step 2).
        true,
      ))
    )
      throw new AccessError(
        "PERMISSION_DENIED",
        "Penyetuju tidak memiliki izin untuk tindakan ini di outlet ini.",
      );
  };
  // 1. The bill and the approver's permission, before the PIN is touched.
  await withTenant(db, context, (tx) =>
    readPosOrder(tx, context, outletId, orderId),
  );
  await withTenant(db, approver, assertApprover);
  // 2. The PIN: counted and committed on its own.
  await attemptApproverPin(tenant, {
    outletId,
    approverUserId,
    requesterUserId: caller.userId,
    pin: input.pin,
    deviceId: caller.deviceId,
    now,
  });
  // 3. Settle. Lock order of every payment: key, then order.
  return withTenant(db, context, async (tx) => {
    if (key !== null) await lockPosIdempotencyKey(tx, context, outletId, key);
    const locked = await lockPosOrder(tx, context, outletId, orderId);
    // A role that ended while the PIN was checked fails closed.
    await assertApprover(tx);
    await assertNotVoidingRecorded(tx, context, orderId, input);
    const settled =
      key === null
        ? await fenceOrder(tx, context, locked, input, now)
        : {
            outcome: await settleKey(tx, context, locked, key, input),
            locked,
          };
    await auditPos(
      tx,
      context,
      {
        action: "pos_order.payment_intent_resolved",
        order: locked.order,
        caller,
        before: { id: orderId, version: locked.pos.version },
        after: {
          id: orderId,
          version: settled.locked.pos.version,
          status: settled.outcome,
          approvedBy: approverUserId,
          method: key === null ? "unknown" : key.split(":")[0],
          // What the supervisor stated about the card, and the settled key.
          kind: input.card ?? null,
          voidRef: input.voidRef ?? null,
          bankRef: input.bankRef ?? null,
          source: key,
        },
        reason: input.reason,
      },
      now,
    );
    return {
      outcome: settled.outcome,
      order: await orderDetail(tx, context, settled.locked),
    };
  });
}
