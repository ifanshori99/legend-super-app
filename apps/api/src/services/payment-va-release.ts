// VA staff release (legend-5wn1e, founder Q93 rule applied to virtual accounts).
// A VA code that is `pending`, `expired` or `failed` with no provider-final
// answer keeps the bill locked (legend-tqkbb, SO-896). When the provider never
// answers, a supervisor may release the code from `expires_at` + 30 min with a
// pos-overrides approval (action `void` on the order, worth at least the code)
// and a written reason. The release is audited and opens one durable row
// (`payment_va_releases`) that keeps asking the provider until it answers for
// good. From then on the code no longer blocks the bill, and money that still
// arrives on it is parked as unallocated funds, never applied (see
// `parkWhenQrisHoldRefusesInTx`). A release is never a capture and never a
// refund.
//
// A guest QR order has no pos_orders row, so the bill is locked as the plain
// `orders` row only (a pos row, if any, would come after it). Lock order is
// untouched (legend-s0u8c): orders -> (pos_orders) -> payment intents -> funds.
// The provider read is outside any transaction.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { PosVaRelease } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { orders, paymentIntents } from "../db/schema/index.ts";
import {
  paymentVaReleases,
  type PaymentVaReleaseResolution,
  type PaymentVaReleaseStatus,
} from "../db/schema/payment-va-release.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import {
  settleGatewayIntentNow,
  settleGatewayIntentNowDetailed,
} from "./payment.service.ts";
import { intentIdsOfPosOrder } from "./pos-order-open-funds.ts";
import {
  auditPos,
  notFound,
  posIdempotent,
  verifyApproval,
  type PosCaller,
} from "./pos-order-support.ts";
import {
  HOLD_RELEASE_AFTER_MS,
  appliedQrisMoneyTx,
  unallocatedFundsOfIntentTx,
} from "./pos-qris-hold.ts";

/** The queue asks the provider for the first time this long after the release. */
const FIRST_CHECK_MS = 2 * 60_000;

type ReleaseRow = typeof paymentVaReleases.$inferSelect;

const RELEASABLE_STATUSES = ["pending", "expired", "failed"] as const;

function notEligible(message: string): HttpError {
  return new HttpError(409, "VA_RELEASE_NOT_ELIGIBLE", message);
}

function paidVaReleaseError(): HttpError {
  return new HttpError(
    409,
    "PAID_VA_RELEASE",
    "Virtual account ini sudah dibayar pelanggan, tidak bisa dirilis.",
  );
}

function providerUnreadError(): HttpError {
  return new HttpError(
    409,
    "VA_RELEASE_PROVIDER_UNREAD",
    "Penyedia belum menjawab status virtual account ini dengan jelas; kode tidak dirilis. Coba lagi nanti.",
  );
}

function dto(row: ReleaseRow): PosVaRelease {
  return {
    id: row.id,
    outletId: row.outletId,
    orderId: row.orderId,
    paymentIntentId: row.paymentIntentId,
    status: row.status as PaymentVaReleaseStatus,
    reason: row.reason,
    releasedBy: row.releasedBy,
    approvedBy: row.approvedBy,
    attempts: row.attempts,
    nextCheckAt: row.nextCheckAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolution: row.resolution as PaymentVaReleaseResolution | null,
  };
}

/** The intent when it is a code of this bill (404 otherwise); no other check. */
async function intentOfOrderTx(
  tx: Tx,
  context: ScopedTenantContext,
  order: { id: string; paymentLinkId: string | null },
  intentId: string,
): Promise<typeof paymentIntents.$inferSelect> {
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
        or(
          eq(paymentIntents.orderId, ulidToUuid(order.id)),
          inArray(paymentIntents.id, intentIdsOfPosOrder(tx, tenantId, order)),
        ),
      ),
    );
  if (!intent)
    throw new CoreError("NOT_FOUND", "Kode pembayaran tidak ditemukan.");
  return intent;
}

/**
 * The intent as it must be to release: a VA code of this bill that the
 * provider received, has not declared final, and that lapsed at least 30 min
 * ago. Throws the refusal otherwise. `order` is the bill the route names.
 */
async function assertReleasableIntentTx(
  tx: Tx,
  context: ScopedTenantContext,
  order: { id: string; paymentLinkId: string | null },
  intentId: string,
  now: Date,
): Promise<typeof paymentIntents.$inferSelect> {
  const tenantId = context.tenant.tenantId;
  const intent = await intentOfOrderTx(tx, context, order, intentId);
  if (intent.method !== "va")
    throw notEligible("Hanya kode virtual account yang bisa dirilis di sini.");
  if (intent.providerRef === null)
    throw notEligible("Kode ini belum diterima penyedia; tidak perlu dirilis.");
  if (intent.providerFinalAt !== null)
    throw notEligible("Penyedia sudah menjawab final untuk kode ini.");
  if (!(RELEASABLE_STATUSES as readonly string[]).includes(intent.status))
    throw notEligible("Kode ini tidak bisa dirilis pada status sekarang.");
  const closedHold = await tx.execute(sql`
    SELECT 1 FROM pos_qris_holds h
    WHERE h.tenant_id = ${tenantId}
      AND h.payment_intent_id = ${intent.id}
      AND h.state = 'closed'
    LIMIT 1`);
  if (closedHold.rows.length > 0) throw notEligible("Kode ini sudah ditutup.");
  const [released] = await tx
    .select({ id: paymentVaReleases.id })
    .from(paymentVaReleases)
    .where(
      and(
        eq(paymentVaReleases.tenantId, tenantId),
        eq(paymentVaReleases.paymentIntentId, intent.id),
      ),
    );
  if (released) throw notEligible("Kode ini sudah dirilis.");
  if (now.getTime() < intent.expiresAt.getTime() + HOLD_RELEASE_AFTER_MS)
    throw notEligible(
      "Virtual account baru boleh dirilis 30 menit setelah kedaluwarsa.",
    );
  return intent;
}

/**
 * POST .../va/release: a supervisor releases a stuck VA code (see the file
 * header). Idempotent by `idempotencyKey`.
 */
export async function releaseVaCode(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: {
    paymentIntentId: string;
    approvedBy: string;
    overrideId: string;
    idempotencyKey: string;
    reason: string;
  },
  now = new Date(),
): Promise<PosVaRelease> {
  const { idempotencyKey, ...request } = input;
  const reason = input.reason.trim();
  const reasonLength = [...reason].length; // code points, like char_length
  if (reasonLength < 3 || reasonLength > 300)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Alasan pelepasan wajib diisi (3 sampai 300 karakter).",
    );
  const tenantId = context.tenant.tenantId;
  const run = () =>
    runRelease(
      context,
      caller,
      outletId,
      orderId,
      idempotencyKey,
      request,
      reason,
      now,
    );
  // Last provider read before the supervisor gives up on the code (912 P1-1):
  // the code is released only when the provider's answer was read and is not
  // paid. A paid answer (any amount, bookkeeping done or not) refuses the
  // release; an error or an answer that proves nothing refuses it too. The
  // money is still recorded by the read itself. Only a code that could be
  // released at all is asked about; any other refusal (or the replay of an
  // earlier release) is decided by the locked run below.
  const releasable = await withTenant(db, context, async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, paymentLinkId: orders.paymentLinkId })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.id, orderId),
          eq(orders.outletId, outletId),
        ),
      );
    if (!order) return false;
    try {
      await assertReleasableIntentTx(
        tx,
        context,
        order,
        input.paymentIntentId,
        now,
      );
      return true;
    } catch (error) {
      if (error instanceof HttpError || error instanceof CoreError)
        return false;
      throw error;
    }
  });
  if (!releasable) return run();
  // A settlement error (a rejected or parked payment, a failed write) is not
  // thrown: the verdict below is read from the provider's answer itself.
  const { verdict } = await settleGatewayIntentNowDetailed(
    context,
    input.paymentIntentId,
    now,
  );
  // Money of this code applied to the bill refuses the release. Read again
  // under the locks below.
  const applied = await withTenant(db, context, (tx) =>
    appliedQrisMoneyTx(tx, tenantId, input.paymentIntentId),
  );
  if (applied || verdict === "paid") throw paidVaReleaseError();
  if (verdict !== "not_paid") throw providerUnreadError();
  return run();
}

async function runRelease(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  idempotencyKey: string,
  request: {
    paymentIntentId: string;
    approvedBy: string;
    overrideId: string;
    reason: string;
  },
  reason: string,
  now: Date,
): Promise<PosVaRelease> {
  const tenantId = context.tenant.tenantId;
  let paidIntentId: string | null = null;
  try {
    return await withTenant(db, context, (tx) =>
      posIdempotent(
        tx,
        context,
        {
          outletId,
          actorId: caller.userId,
          key: idempotencyKey,
          operation: "order.va_release",
          target: orderId,
          request: {
            body: request,
            expectedVersion: caller.expectedVersion,
          },
        },
        async () => {
          assertOutletInScope(context.outletScope, outletId);
          const [order] = await tx
            .select()
            .from(orders)
            .where(
              and(
                eq(orders.tenantId, tenantId),
                eq(orders.id, orderId),
                eq(orders.outletId, outletId),
              ),
            )
            .for("update");
          if (!order) throw notFound();
          // The intent row is locked first, then everything is judged on what is
          // recorded now: a payment that committed after the early read refuses
          // the release (the transaction rolls back; the payment is finished
          // below, outside the locks).
          // Ownership first: a foreign intent id is a 404 before any money read.
          await intentOfOrderTx(tx, context, order, request.paymentIntentId);
          if (await appliedQrisMoneyTx(tx, tenantId, request.paymentIntentId)) {
            paidIntentId = request.paymentIntentId;
            throw paidVaReleaseError();
          }
          const intent = await assertReleasableIntentTx(
            tx,
            context,
            order,
            request.paymentIntentId,
            now,
          );
          // Guest money of this code sits parked and open (an amount mismatch):
          // releasing would let the cashier take the whole bill again while that
          // money is still owed back.
          if (
            (await unallocatedFundsOfIntentTx(tx, tenantId, intent.id)).open > 0
          )
            throw new HttpError(
              409,
              "FUNDS_UNRESOLVED",
              "Uang pelanggan dari virtual account ini masih tersimpan; kembalikan atau selesaikan dulu sebelum kode dirilis.",
            );
          const override = await verifyApproval(tx, context, {
            action: "void",
            outletId,
            orderId: order.id,
            objectType: "order",
            objectId: order.id,
            requesterId: caller.userId,
            approvedBy: request.approvedBy,
            overrideId: request.overrideId,
            minValueIdr: intent.amountIdr,
            deviceId: caller.deviceId,
            now,
          });
          const id = createUlid(now.getTime());
          const [row] = await tx
            .insert(paymentVaReleases)
            .values({
              tenantId,
              id,
              outletId,
              paymentIntentId: intent.id,
              orderId: order.id,
              reason,
              releasedBy: caller.userId,
              approvedBy: request.approvedBy,
              overrideId: override.id,
              status: "open",
              nextCheckAt: new Date(now.getTime() + FIRST_CHECK_MS),
            })
            .returning();
          if (!row) throw notEligible("Kode ini sudah dirilis.");
          await auditPos(
            tx,
            context,
            {
              action: "payment_va_code.force_released",
              order,
              caller,
              before: {
                id: order.id,
                amountIdr: intent.amountIdr,
                status: intent.status,
              },
              after: {
                id: order.id,
                status: "released",
                approvedBy: request.approvedBy,
                overrideId: override.id,
                approvalRequestId: override.approvalRequestId,
              },
              reason,
              objectType: "payment_intent",
              objectId: intent.id,
            },
            now,
          );
          await notifyOutletSupervisors(
            tx,
            context,
            {
              tenantId,
              outletId,
              alsoOwners: true,
              alsoUserIds: [caller.userId],
              id,
              eventName: "payment_va_release.opened",
              aggregateType: "payment_va_release",
              aggregateId: id,
              payload: { releaseId: id, orderId: order.id },
              title: "Virtual account dirilis, uang belum terkonfirmasi",
              body: "Virtual account dirilis tanpa bukti penyedia. Sistem terus menanyai penyedia; bila uang masuk, uang ditahan di dana belum teralokasi untuk dikembalikan ke pembayar.",
            },
            now,
          );
          return dto(row);
        },
      ),
    );
  } catch (error) {
    if (paidIntentId !== null) {
      // Finish the payment (capture once); the bill stays locked until then.
      try {
        await settleGatewayIntentNow(context, paidIntentId, now);
      } catch {
        // Already recorded; the consumer or the next check finishes it.
      }
    }
    throw error;
  }
}
