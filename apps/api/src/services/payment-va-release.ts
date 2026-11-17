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

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
  type PaymentVaReleaseKind,
  type PaymentVaReleaseResolution,
  type PaymentVaReleaseStatus,
} from "../db/schema/payment-va-release.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import { liveCodeWhere } from "./payment-live-code.ts";
import {
  cancelSupersededAtGateway,
  expireVoidedCodesTx,
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
/** legend-24ogm: the provider is read outside the locks. An answer older than
 * this when the order lock is taken proves nothing about now (a payment may
 * have landed in between), so the release is refused and may be retried. No
 * network call happens inside the lock. */
export const VA_RELEASE_PROVIDER_READ_MAX_AGE_MS = 30_000;

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
    // A staff row always carries both (the kind actor check); only a guest
    // method change has neither, and it never goes through this DTO.
    releasedBy: row.releasedBy ?? "",
    approvedBy: row.approvedBy ?? "",
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
  kind: PaymentVaReleaseKind = "staff",
): Promise<typeof paymentIntents.$inferSelect> {
  const tenantId = context.tenant.tenantId;
  const intent = await intentOfOrderTx(tx, context, order, intentId);
  // legend-9vmit: a bank transfer code (an orphan of it too) is released like a
  // virtual account; QRIS has its own hold and release.
  if (intent.method !== "va" && intent.method !== "bank_transfer")
    throw notEligible(
      "Hanya kode virtual account atau transfer bank yang bisa dirilis di sini.",
    );
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
  // The wait protects staff from releasing a code that is still payable. A
  // guest who picked another method (the guest owns the bill) needs no wait: the
  // provider read plus the release row stand in for it (legend-9vmit).
  if (
    kind === "staff" &&
    now.getTime() < intent.expiresAt.getTime() + HOLD_RELEASE_AFTER_MS
  )
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
  const run = (providerReadAt: Date | null = null) =>
    runRelease(
      context,
      caller,
      outletId,
      orderId,
      idempotencyKey,
      request,
      reason,
      now,
      providerReadAt,
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
  // Taken before the read: the answer is at least this old at lock time.
  const providerReadAt = new Date();
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
  return run(providerReadAt);
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
  providerReadAt: Date | null,
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
          // The provider answer behind this release is too old now (legend-24ogm):
          // nothing is released and the approval is not spent (the transaction
          // rolls back); the caller reads again.
          if (
            providerReadAt !== null &&
            new Date().getTime() - providerReadAt.getTime() >
              VA_RELEASE_PROVIDER_READ_MAX_AGE_MS
          )
            throw providerUnreadError();
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

// ---- Guest method change (legend-9vmit, founder Q15) -----------------------------

/** What the bill history shows for a code the system voided on a method change. */
const METHOD_CHANGE_REASON =
  "Tamu mengganti metode pembayaran; kode lama ditutup sistem";

function methodChangePaidError(): HttpError {
  return new HttpError(
    409,
    "PAID_VA_RELEASE",
    "Kode pembayaran sebelumnya sudah dibayar, jadi metodenya tidak bisa diganti. Tunggu pembayaran dicatat.",
  );
}

function methodChangeUnreadError(): HttpError {
  return new HttpError(
    409,
    "VA_RELEASE_PROVIDER_UNREAD",
    "Kami belum bisa memastikan status kode pembayaran sebelumnya. Coba lagi sebentar lagi.",
  );
}

/**
 * The guest picked another method or bank: voids the live VA / bank transfer
 * code(s) of the scope so the new code can issue (one active code per bill).
 * Scope: `billSplitId` null = the bill-level codes (`bill_split_id` null);
 * otherwise only the codes of that part. Every other live code of the guard's
 * scope (a QRIS hold, a code of another part, a code the provider never
 * received) is outside this void: then NOTHING is voided and `voided` is empty,
 * so the caller's own refusal stands.
 *
 * Same safety as the staff release, minus the staff: the provider is read
 * outside any lock and must answer `not_paid`; the answer may not be older than
 * `VA_RELEASE_PROVIDER_READ_MAX_AGE_MS` when the order lock is taken; money of
 * the code already recorded or parked refuses it; then ONE transaction under the
 * order lock inserts a `guest_method_change` release row per code (durable
 * queue: the provider keeps being asked, money that arrives later is parked
 * as unallocated funds for refund, never applied to the bill) and turns the
 * still-pending code `expired` locally. Committed before this returns. After the
 * commit the provider is asked to close the code (best effort). The new code is
 * issued by the caller only after this, so no moment has two collectible codes.
 */
export async function voidLiveCodesForMethodChange(
  context: ScopedTenantContext,
  scope: {
    paymentLinkId: string;
    billSplitId: string | null;
    /** The code the guest asks for now. A live code that is still pending with
     * this very choice is the guest's code: nothing is voided (a reload that
     * picks the same bank must not kill a code that may already be paid). */
    next?: { method: string; channelCode: string | null };
  },
  now = new Date(),
): Promise<{ voided: string[] }> {
  const tenantId = context.tenant.tenantId;
  const inScope = and(
    eq(paymentIntents.tenantId, tenantId),
    eq(paymentIntents.paymentLinkId, scope.paymentLinkId),
    scope.billSplitId === null
      ? undefined
      : or(
          eq(paymentIntents.billSplitId, scope.billSplitId),
          isNull(paymentIntents.billSplitId),
        ),
    liveCodeWhere(),
  );
  const exact = (row: { billSplitId: string | null }) =>
    row.billSplitId === scope.billSplitId;
  // Only a code the guest is still entitled to pay (pending, inside its expiry)
  // is voided by the guest's own choice. A lapsed or failed code the provider
  // has not declared final keeps the staff rule (Q93: supervisor approval and
  // 30 min after expiry): the guest never ends it on their own.
  const isVoidable = (row: typeof paymentIntents.$inferSelect) =>
    exact(row) &&
    (row.method === "va" || row.method === "bank_transfer") &&
    row.providerRef !== null &&
    row.providerFinalAt === null &&
    row.status === "pending" &&
    row.expiresAt.getTime() > now.getTime();

  // 1) Candidates, read without a lock.
  const live = await withTenant(db, context, async (tx) => {
    const [order] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.paymentLinkId, scope.paymentLinkId),
        ),
      );
    if (!order) return null;
    return {
      orderId: order.id,
      rows: await tx.select().from(paymentIntents).where(inScope),
    };
  });
  if (live === null || live.rows.length === 0) return { voided: [] };
  if (!live.rows.every(isVoidable)) return { voided: [] };
  const next = scope.next;
  if (
    next !== undefined &&
    live.rows.every(
      (row) =>
        row.status === "pending" &&
        row.method === next.method &&
        (row.channelCode ?? null) === (next.channelCode ?? null),
    )
  )
    return { voided: [] };

  // 2) The provider, outside any lock. A paid answer (or money already applied)
  // refuses the change; the read itself records the money.
  // Read together, so a second code cannot age the first answer past the bound.
  const reads = new Map<string, Date>();
  const verdicts = await Promise.all(
    live.rows.map(async (row) => {
      const readAt = new Date();
      const { verdict } = await settleGatewayIntentNowDetailed(
        context,
        row.id,
        now,
      );
      const applied = await withTenant(db, context, (tx) =>
        appliedQrisMoneyTx(tx, tenantId, row.id),
      );
      reads.set(row.id, readAt);
      return { applied, verdict };
    }),
  );
  if (verdicts.some((v) => v.applied || v.verdict === "paid"))
    throw methodChangePaidError();
  if (verdicts.some((v) => v.verdict !== "not_paid"))
    throw methodChangeUnreadError();

  // 3) One transaction under the order lock.
  let paidIntentId: string | null = null;
  let cancels: Awaited<ReturnType<typeof expireVoidedCodesTx>> = [];
  let voided: string[] = [];
  try {
    await withTenant(db, context, async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, live.orderId)))
        .for("update");
      if (!order) return;
      // Judged on what is committed now. A code that appeared or changed since
      // the read has no fresh provider answer: refuse and let the guest retry.
      const lockedRows = await tx.select().from(paymentIntents).where(inScope);
      if (lockedRows.length === 0) return; // a twin already voided them
      if (!lockedRows.every(isVoidable)) throw methodChangeUnreadError();
      const releasedRows: (typeof paymentIntents.$inferSelect)[] = [];
      for (const row of lockedRows) {
        const readAt = reads.get(row.id);
        if (
          readAt === undefined ||
          new Date().getTime() - readAt.getTime() >
            VA_RELEASE_PROVIDER_READ_MAX_AGE_MS
        )
          throw methodChangeUnreadError();
        if (await appliedQrisMoneyTx(tx, tenantId, row.id)) {
          paidIntentId = row.id;
          throw methodChangePaidError();
        }
        const intent = await assertReleasableIntentTx(
          tx,
          context,
          order,
          row.id,
          now,
          "guest_method_change",
        );
        // Parked guest money on the code (an amount mismatch) is still owed back:
        // no new code before it is returned (same rule as the staff release).
        if (
          (await unallocatedFundsOfIntentTx(tx, tenantId, intent.id)).open > 0
        )
          throw new HttpError(
            409,
            "FUNDS_UNRESOLVED",
            "Uang dari pembayaran sebelumnya belum dikembalikan; selesaikan dulu sebelum membayar lagi.",
          );
        await tx.insert(paymentVaReleases).values({
          tenantId,
          id: createUlid(now.getTime()),
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          orderId: order.id,
          reason: METHOD_CHANGE_REASON,
          kind: "guest_method_change",
          status: "open",
          nextCheckAt: new Date(now.getTime() + FIRST_CHECK_MS),
        });
        releasedRows.push(intent);
      }
      cancels = await expireVoidedCodesTx(tx, context, releasedRows, now);
      voided = releasedRows.map((row) => row.id);
    });
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
  // The provider is asked to close the old codes; the release rows keep asking
  // until it answers final, so a failed cancel loses nothing.
  if (cancels.length > 0) await cancelSupersededAtGateway(context, cancels);
  return { voided };
}
