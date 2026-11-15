// Per-order bill splits (bead legend-ms3; docs/briefs/sub-split-bill-design.md
// D1, D3, D4; PRD ORD-06). A pay-first order waiting for payment is cut into
// 2+ parts (equal, by item or by person); each part is paid through its own
// payment intent (qr-order-payment.ts). A re-split voids the live set and
// inserts a new one under a fresh `split_set_id`.
//
// - Scope (D1): one order, the session's single `awaiting_payment` order. The
//   server finds it; the guest names no order.
// - Rounding (D3): `splitBill` cuts the order total (tax, service charge and
//   rounding included) and `assertSplitsSumToTotal` guards the insert.
// - Lock order: session -> order -> bill_splits -> payment link.
// - A paid part issues a one-time claim token (`sc_...`), shown to the payer
//   for 24 hours. The raw token is sealed; its SHA-256 is the lookup key.
//   Redeeming has no public route yet (waits legend-111j).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  gt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  toIsoDateTime,
  ulidToUuid,
  uuidToUlid,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertSplitsSumToTotal,
  billSplitSchema,
  sessionBillSchema,
  sessionSplitsResultSchema,
  splitBill,
  splitClaimSchema,
  type BillSplit,
  type CreateSplitsInput,
  type SessionSplitsResult,
  type SplitClaim,
} from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import {
  billSplits,
  loyaltyClaimPauses,
  paymentIntents,
  paymentLinks,
  sessionParticipants,
} from "../db/schema/index.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { activeHoldOf } from "./pos-qris-hold.ts";
import { failedOrderCodeWithOpenFundTx } from "./payment-failed-funds.ts";
import { expiredCodeMayStillPay } from "./payment-live-code.ts";
import {
  getSessionBill,
  lockGuestSessionForPayment,
  qrOrderIdempotent,
  type QrOrderRow,
} from "./qr-order.service.ts";
import { orderRefunded, orderTraining } from "./table-claim.service.ts";
import { checkLoyaltyOutletEntity } from "./loyalty-entity-guard.ts";
import { retryBusyClaimsForSessionInTransaction } from "./loyalty-claim-recovery.ts";

export type BillSplitRow = typeof billSplits.$inferSelect;

/** A claim token lives 24 hours after the part is paid. */
const CLAIM_TTL_MS = 24 * 60 * 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function claimAad(tenantId: string, splitId: string): string {
  return `bill-split-claim:${tenantId}:${splitId}`;
}

function unprocessable(code: string, message: string): HttpError {
  return new HttpError(422, code, message);
}

// ---- DTO ------------------------------------------------------------------

export function splitRowToDto(row: BillSplitRow): BillSplit {
  return billSplitSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    tableSessionId: row.tableSessionId,
    orderId: row.orderId,
    method: row.method,
    shareIndex: row.shareIndex,
    amountIdr: row.amountIdr,
    status: row.status,
    label: row.label,
    itemIds: row.itemIds.map((id) => uuidToUlid(id)),
    participantId: row.participantId,
    createdAt: toIsoDateTime(row.createdAt),
  });
}

// ---- Reads and locks ---------------------------------------------------------------

/** Live (non-voided) parts of an order, lowest share index first. */
export async function listLiveSplitsTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<BillSplitRow[]> {
  return tx
    .select()
    .from(billSplits)
    .where(
      and(
        eq(billSplits.tenantId, context.tenant.tenantId),
        eq(billSplits.orderId, orderId),
        ne(billSplits.status, "voided"),
      ),
    )
    .orderBy(asc(billSplits.shareIndex));
}

/** One part of the session, locked FOR UPDATE; 404 when it is not in it. */
export async function lockSplitPartTx(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  splitId: string,
): Promise<BillSplitRow> {
  const [row] = await tx
    .select()
    .from(billSplits)
    .where(
      and(
        eq(billSplits.tenantId, context.tenant.tenantId),
        eq(billSplits.id, splitId),
        eq(billSplits.tableSessionId, sessionId),
      ),
    )
    // NO KEY UPDATE, not UPDATE: the part's intent is inserted by
    // createSplitPartIntent on another connection, and its FK check takes KEY
    // SHARE on this row; FOR UPDATE would block that insert while this
    // transaction waits on it (self-deadlock).
    .for("no key update");
  if (!row) throw new CoreError("NOT_FOUND", "Bagian tagihan tidak ditemukan.");
  assertOutletInScope(context.outletScope, row.outletId);
  return row;
}

/** The session's live parts as DTOs (GET /bill fills `splits` with them). */
export async function listSessionSplitDtosTx(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
): Promise<BillSplit[]> {
  const rows = await tx
    .select()
    .from(billSplits)
    .where(
      and(
        eq(billSplits.tenantId, context.tenant.tenantId),
        eq(billSplits.tableSessionId, sessionId),
        ne(billSplits.status, "voided"),
      ),
    )
    .orderBy(asc(billSplits.createdAt), asc(billSplits.shareIndex));
  return rows.map(splitRowToDto);
}

// ---- Guards -------------------------------------------------------------------------

/**
 * A code that may still take money. Any `pending` code, whatever its expiry:
 * a lapsed one stays pending until reconciliation hears the gateway's final
 * answer, and it may turn out paid (payment.service.ts `supersedePending`). And
 * an `expired` code the gateway received until the PROVIDER answered final or
 * its money was reconciled (SO-885, `expiredCodeMayStillPay`): the gateway
 * cancel is best effort and the local timeout is not proof.
 */
function liveCodeWhere() {
  return or(eq(paymentIntents.status, "pending"), expiredCodeMayStillPay());
}

/**
 * The split can change only while no money moved: 409 `SPLIT_LOCKED` when a
 * live part is paid, the order's link took money, or a code on the link is
 * still open (pending, or expired with a provider ref until the provider
 * answered final: `liveCodeWhere`; local time never counts as proof).
 * Locks the live parts so a concurrent webhook settles before or after us.
 */
export async function assertSplitMutableTx(
  tx: Tx,
  context: ScopedTenantContext,
  order: QrOrderRow,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const live = await tx
    .select({ status: billSplits.status })
    .from(billSplits)
    .where(
      and(
        eq(billSplits.tenantId, tenantId),
        eq(billSplits.orderId, order.id),
        ne(billSplits.status, "voided"),
      ),
    )
    .for("no key update");
  const locked = (message: string) =>
    new HttpError(409, "SPLIT_LOCKED", message);
  if (live.some((part) => part.status === "paid"))
    throw locked("Ada bagian yang sudah dibayar; pembagian tidak bisa diubah.");
  // legend-yhia9: a QRIS of a part (or of the bill) that can still be paid
  // freezes the split until the provider shows it paid or dead.
  if (await activeHoldOf(tx, tenantId, order.id))
    throw locked(
      "Ada QR pembayaran yang masih bisa dibayar; tunggu sampai dibayar atau berakhir.",
    );
  // SO-889: a failed code of the order (whole-order or any part, voided or
  // not) whose money is still parked blocks a new split and a whole-order
  // payment until it is refunded or credited; else the guest pays twice.
  if (await failedOrderCodeWithOpenFundTx(tx, tenantId, order))
    throw new HttpError(
      409,
      "FUNDS_UNRESOLVED",
      "Uang dari pembayaran sebelumnya belum dikembalikan; selesaikan dulu sebelum membayar lagi.",
    );
  if (order.paymentLinkId === null) return;
  const [link] = await tx
    .select({ paidIdr: paymentLinks.paidIdr })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, order.paymentLinkId),
      ),
    );
  if (link && link.paidIdr > 0)
    throw locked("Pesanan ini sudah menerima pembayaran.");
  const open = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, order.paymentLinkId),
        liveCodeWhere(),
      ),
    )
    .limit(1);
  if (open.length > 0)
    throw locked("Ada kode pembayaran yang masih aktif; tunggu sampai habis.");
}

/**
 * The part's newest live code (`liveCodeWhere`): an intent with
 * `bill_split_id = partId` that may still take money. null when there is none.
 */
export async function partLiveCodeTx(
  tx: Tx,
  context: ScopedTenantContext,
  partId: string,
): Promise<{
  id: string;
  method: string;
  channelCode: string | null;
  status: string;
} | null> {
  const [code] = await tx
    .select({
      id: paymentIntents.id,
      method: paymentIntents.method,
      channelCode: paymentIntents.channelCode,
      status: paymentIntents.status,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.billSplitId, partId),
        liveCodeWhere(),
      ),
    )
    .orderBy(desc(paymentIntents.createdAt))
    .limit(1);
  return code ?? null;
}

// ---- Create -------------------------------------------------------------------------

/**
 * POST /api/table-sessions/:sessionId/splits. Cuts the session's one
 * `awaiting_payment` order into parts and voids the live set it replaces.
 * The stored idempotent answer is the new set id; the bill and the parts are
 * read after commit, so a replay shows the parts as they are now.
 */
export async function createSessionSplits(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: CreateSplitsInput,
  now = new Date(),
): Promise<SessionSplitsResult> {
  const tenantId = context.tenant.tenantId;
  const stored = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const { idempotencyKey, ...request } = input;
    return qrOrderIdempotent<{ splitSetId: string }>(
      tx,
      context,
      { sessionId: session.id, outletId: session.outletId },
      idempotencyKey,
      "split.create",
      request,
      async () => {
        // D1: the session's single order waiting for payment.
        const sessionAwaiting = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.tableSessionId, session.id),
              eq(orders.status, "awaiting_payment"),
            ),
          )
          .orderBy(asc(orders.id))
          .for("update");
        const awaiting = sessionAwaiting.filter(
          (order) =>
            order.channel === "qr" && order.paymentMode === "pay_first",
        );
        if (sessionAwaiting.length > 0 && awaiting.length === 0)
          throw new CoreError(
            "CONFLICT",
            "Pesanan ini dibayar melalui kasir, bukan pembagian tagihan tamu.",
          );
        if (awaiting.length === 0)
          throw unprocessable(
            "NOTHING_TO_SPLIT",
            "Tidak ada pesanan yang menunggu pembayaran untuk dibagi.",
          );
        if (awaiting.length > 1)
          throw new CoreError(
            "CONFLICT",
            "Ada lebih dari satu pesanan yang menunggu pembayaran.",
          );
        const order = awaiting[0];
        if (order.depositAppliedIdr > 0)
          throw unprocessable(
            "VALIDATION_ERROR",
            "Pesanan dengan deposit reservasi belum bisa dibagi.",
          );
        await assertSplitMutableTx(tx, context, order);
        if (order.paymentLinkId !== null) {
          const [link] = await tx
            .select({
              totalIdr: paymentLinks.totalIdr,
              paidIdr: paymentLinks.paidIdr,
            })
            .from(paymentLinks)
            .where(
              and(
                eq(paymentLinks.tenantId, tenantId),
                eq(paymentLinks.id, order.paymentLinkId),
              ),
            );
          if (link && (link.totalIdr !== order.totalIdr || link.paidIdr !== 0))
            throw new CoreError(
              "CONFLICT",
              "Tagihan pesanan ini berubah; muat ulang lalu coba lagi.",
            );
        }

        const items = await tx
          .select({
            id: orderItems.id,
            lineTotalIdr: orderItems.lineTotalIdr,
          })
          .from(orderItems)
          .where(
            and(
              eq(orderItems.tenantId, tenantId),
              eq(orderItems.orderId, order.id),
              ne(orderItems.status, "voided"),
            ),
          );
        await assertParticipantsInSession(tx, context, session.id, input);

        const drafts = draftParts(
          input,
          order.totalIdr,
          items.map((item) => ({
            orderItemId: item.id,
            lineTotalIdr: item.lineTotalIdr,
          })),
        );

        await voidLiveSplitsTx(tx, context, order.id, now);
        const splitSetId = randomUUID();
        await tx.insert(billSplits).values(
          drafts.map((draft) => ({
            tenantId,
            outletId: order.outletId,
            tableSessionId: session.id,
            orderId: order.id,
            splitSetId,
            method: draft.method,
            shareIndex: draft.shareIndex,
            amountIdr: draft.amountIdr,
            label: draft.label,
            itemIds: draft.itemIds.map((id) => ulidToUuid(id)),
            participantId: draft.participantId,
            createdAt: now,
            updatedAt: now,
          })),
        );
        await tx
          .update(orders)
          .set({ paymentIntentId: null, updatedAt: now })
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)));
        return { splitSetId };
      },
    );
  });

  const bill = await getSessionBill(context, credential, sessionId, now);
  return withTenant(db, context, async (tx) => {
    const created = await tx
      .select()
      .from(billSplits)
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.splitSetId, stored.splitSetId),
          eq(billSplits.tableSessionId, sessionId),
        ),
      )
      .orderBy(asc(billSplits.shareIndex));
    const live = await listSessionSplitDtosTx(tx, context, sessionId);
    return sessionSplitsResultSchema.parse({
      bill: sessionBillSchema.parse({ ...bill, splits: live }),
      splits: created.map(splitRowToDto),
    });
  });
}

/** D3: `splitBill` on the order total; any bad input or a zero part is 422. */
function draftParts(
  input: CreateSplitsInput,
  totalIdr: Idr,
  lines: { orderItemId: string; lineTotalIdr: Idr }[],
) {
  const fail = () =>
    unprocessable(
      "VALIDATION_ERROR",
      "Pembagian tidak valid: setiap item harus masuk tepat satu bagian dan tiap bagian harus lebih dari nol.",
    );
  try {
    const drafts =
      input.method === "equal"
        ? splitBill({ method: "equal", totalIdr, parts: input.parts })
        : input.method === "by_person"
          ? splitBill({
              method: "by_person",
              totalIdr,
              participantIds: input.participantIds,
            })
          : splitBill({
              method: "by_item",
              totalIdr,
              lines,
              assignments: input.assignments,
            });
    if (drafts.some((draft) => draft.amountIdr <= 0)) throw fail();
    assertSplitsSumToTotal(drafts, totalIdr);
    return drafts;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof RangeError) throw fail();
    throw error;
  }
}

/** Named participants must belong to this session (the FK checks tenant only). */
async function assertParticipantsInSession(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  input: CreateSplitsInput,
): Promise<void> {
  const ids =
    input.method === "by_person"
      ? input.participantIds
      : input.method === "by_item"
        ? input.assignments.flatMap((assignment) =>
            assignment.participantId ? [assignment.participantId] : [],
          )
        : [];
  const unique = [...new Set<string>(ids)];
  if (unique.length === 0) return;
  const found = await tx
    .select({ id: sessionParticipants.id })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.tenantId, context.tenant.tenantId),
        eq(sessionParticipants.tableSessionId, sessionId),
        inArray(sessionParticipants.id, unique),
      ),
    );
  if (found.length !== unique.length)
    throw unprocessable(
      "VALIDATION_ERROR",
      "Peserta tidak ada di sesi meja ini.",
    );
}

// ---- Void ---------------------------------------------------------------------------

/** Pending parts of the order become voided; paid parts stay. Returns the count. */
export async function voidLiveSplitsTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  now: Date,
): Promise<number> {
  const voided = await tx
    .update(billSplits)
    .set({ status: "voided", voidedAt: now, updatedAt: now })
    .where(
      and(
        eq(billSplits.tenantId, context.tenant.tenantId),
        eq(billSplits.orderId, orderId),
        eq(billSplits.status, "pending"),
      ),
    )
    .returning({ id: billSplits.id });
  return voided.length;
}

/**
 * A voided order: its paid parts' unredeemed claims end now. Returns the
 * count. Run with `voidLiveSplitsTx` when the order is voided.
 */
export async function expireSplitClaimsTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  now: Date,
): Promise<number> {
  const expired = await tx
    .update(billSplits)
    .set({ claimExpiresAt: now, updatedAt: now })
    .where(
      and(
        eq(billSplits.tenantId, context.tenant.tenantId),
        eq(billSplits.orderId, orderId),
        eq(billSplits.status, "paid"),
        isNull(billSplits.claimRedeemedAt),
        gt(billSplits.claimExpiresAt, now),
      ),
    )
    .returning({ id: billSplits.id });
  return expired.length;
}

// ---- Paid and claim -------------------------------------------------------------------

/**
 * What the paid intent put toward the bill: the money its provider evidence
 * brought in, less the part booked as unallocated funds. Same rule as
 * qr-order-consumers `allocatedIdrByIntent`, for one intent.
 */
async function allocatedIdrOfIntent(
  tx: Tx,
  context: ScopedTenantContext,
  intentId: string,
): Promise<number> {
  const result = await tx.execute<{ allocated: string }>(sql`
    SELECT (coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
                       WHERE e.tenant_id = ${context.tenant.tenantId}
                         AND e.payment_intent_id = ${intentId}), 0)
          - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
                       WHERE f.tenant_id = ${context.tenant.tenantId}
                         AND f.payment_intent_id = ${intentId}), 0))::text AS allocated`);
  return Number(result.rows[0]?.allocated ?? 0);
}

/**
 * Marks the part a paid intent covers as paid and issues its claim token.
 * `no_split`: the intent is not for a part, or nothing was marked (the intent
 * is not paid, or its allocation is below the part). `already`: the part is
 * no longer pending (replay, or voided). Replay safe: the UPDATE only moves
 * a `pending` part.
 */
export async function markSplitPartPaidTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: { intentId: string; now: Date },
): Promise<"no_split" | "marked" | "already"> {
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select({
      billSplitId: paymentIntents.billSplitId,
      status: paymentIntents.status,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, input.intentId),
      ),
    );
  if (!intent || intent.billSplitId === null) return "no_split";
  const [part] = await tx
    .select()
    .from(billSplits)
    .where(
      and(
        eq(billSplits.tenantId, tenantId),
        eq(billSplits.id, intent.billSplitId),
      ),
    )
    .for("no key update");
  if (!part) return "no_split";
  if (part.status !== "pending") {
    // Another intent already paid the part, or it was voided: no refund
    // logic here, only a trace (identifiers only).
    if (
      intent.status === "paid" &&
      (part.status === "voided" || part.paymentIntentId !== input.intentId)
    )
      logger.warn(
        {
          billSplitId: part.id,
          intentId: input.intentId,
          partStatus: part.status,
          paidByIntentId: part.paymentIntentId,
        },
        "Bill split: an intent settled for a part already paid by another intent or voided",
      );
    return "already";
  }
  if (intent.status !== "paid") return "no_split";
  const allocated = await allocatedIdrOfIntent(tx, context, input.intentId);
  if (allocated < part.amountIdr) return "no_split";

  const verdict = await checkLoyaltyOutletEntity(tx, tenantId, [part.outletId]);
  const paused = verdict !== "ok";
  const raw = `sc_${randomBytes(32).toString("base64url")}`;
  const marked = await tx
    .update(billSplits)
    .set({
      status: "paid",
      paymentIntentId: input.intentId,
      paidAt: input.now,
      claimTokenHash: sha256(raw),
      claimTokenSealed: sealSecret(raw, claimAad(tenantId, part.id)),
      claimExpiresAt: new Date(input.now.getTime() + CLAIM_TTL_MS),
      // legend-r77pq: the hash only survives when the part's own intent paid.
      // An old intent settling after a takeover leaves no one holding a
      // matching secret: the token then reaches the guest only via the receipt.
      ...(part.paymentIntentId === input.intentId
        ? {}
        : { payerSecretHash: null }),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(billSplits.tenantId, tenantId),
        eq(billSplits.id, part.id),
        eq(billSplits.status, "pending"),
      ),
    )
    .returning({ id: billSplits.id });
  if (paused && marked.length > 0)
    await tx
      .insert(loyaltyClaimPauses)
      .values({
        tenantId,
        outletId: part.outletId,
        splitId: part.id,
        pausedAt: input.now,
        remainingMs: CLAIM_TTL_MS,
        state: verdict === "busy" ? "busy" : "ambiguous",
      })
      .onConflictDoNothing();
  return marked.length > 0 ? "marked" : "already";
}

/**
 * legend-udu47: the points of this part cannot be claimed (the POST answers
 * 409), so the code is not shown either: the order has a refund, was rung up
 * in practice (latihan) mode, is voided, or already has a member attached (the
 * earn consumer credits them). Same conditions as `redeemSplit` in
 * `table-claim.service`.
 */
async function orderBlocksClaim(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
): Promise<boolean> {
  const [blocked] = await tx
    .select({ one: sql<number>`1` })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        or(
          eq(orders.status, "voided"),
          isNotNull(orders.customerProfileId),
          orderRefunded(tenantId),
          orderTraining(tenantId),
        ),
      ),
    )
    .limit(1);
  return blocked !== undefined;
}

/**
 * GET .../splits/:splitId/claim. `unavailable` when the paid part shows no
 * code (no token, or its order is voided, refunded, a member's or practice);
 * `available` shows the token for 24 hours; `claimed` once redeemed;
 * `expired` after the deadline. The part ids are public to the table, so the
 * read also needs the payer secret given when the part was paid
 * (legend-r77pq): compared as a SHA-256 in the same query, so a wrong secret,
 * a foreign part, an unknown part and a part nobody started paying answer the
 * same NOT_FOUND. The token itself shows only while the part is `paid`.
 */
export async function getSplitClaim(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  splitId: string,
  payerSecret: string,
  now = new Date(),
): Promise<SplitClaim> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    await retryBusyClaimsForSessionInTransaction(tx, context, session.id, now);
    const [part] = await tx
      .select()
      .from(billSplits)
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.id, splitId),
          eq(billSplits.tableSessionId, session.id),
          eq(billSplits.payerSecretHash, sha256(payerSecret)),
        ),
      );
    if (!part)
      throw new CoreError("NOT_FOUND", "Bagian tagihan tidak ditemukan.");
    const claim = (
      status: SplitClaim["status"],
      claimToken: string | null,
      claimableUntil: Date | null,
    ) =>
      splitClaimSchema.parse({
        billSplitId: part.id,
        status,
        claimToken,
        claimableUntil: claimableUntil ? toIsoDateTime(claimableUntil) : null,
      });
    if (
      part.status !== "paid" ||
      part.claimTokenSealed === null ||
      part.claimExpiresAt === null
    )
      return claim("unavailable", null, null);
    if (part.claimRedeemedAt !== null) return claim("claimed", null, null);
    const [paused] = await tx
      .select({
        state: loyaltyClaimPauses.state,
        deadline: loyaltyClaimPauses.resumeDeadline,
      })
      .from(loyaltyClaimPauses)
      .where(
        and(
          eq(loyaltyClaimPauses.tenantId, tenantId),
          eq(loyaltyClaimPauses.splitId, part.id),
        ),
      );
    if (paused && paused.state !== "active") {
      // The payer must retain the bearer code before the session closes: the
      // session credential is rotated on close. The existing payer-secret
      // check above prevents another diner from receiving it. A paused code is
      // not redeemable and is never revealed after a refund/void/training.
      if (await orderBlocksClaim(tx, tenantId, part.orderId))
        return claim("unavailable", null, null);
      return claim(
        "unavailable",
        openSecret(part.claimTokenSealed, claimAad(tenantId, part.id)),
        null,
      );
    }
    const deadline = paused?.deadline ?? part.claimExpiresAt;
    if (deadline.getTime() <= now.getTime())
      return claim("expired", null, null);
    if (await orderBlocksClaim(tx, tenantId, part.orderId))
      return claim("unavailable", null, null);
    return claim(
      "available",
      openSecret(part.claimTokenSealed, claimAad(tenantId, part.id)),
      deadline,
    );
  });
}

/**
 * legend-ia54l (founder Q75): the guest opens the claim code from the phone
 * for 24 hours after the part is paid, also after the table is closed. The
 * proof is the claim token itself (printed on the receipt), not the table
 * session, so a closed session does not block it. Reads one part only and
 * returns the same four fields as `getSplitClaim`: no other guest's part, no
 * order data. Unknown, used, expired or voided: the same NOT_FOUND, so the
 * route is no oracle.
 */
export async function getSplitClaimByToken(
  context: ScopedTenantContext,
  rawToken: string,
  now = new Date(),
): Promise<SplitClaim> {
  const tenantId = context.tenant.tenantId;
  const notFound = () =>
    new CoreError("NOT_FOUND", "Kode klaim tidak ditemukan atau sudah habis.");
  return withTenant(db, context, async (tx) => {
    const [unit] = await tx
      .select({ sessionId: billSplits.tableSessionId })
      .from(billSplits)
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.claimTokenHash, sha256(rawToken)),
        ),
      );
    if (unit)
      await retryBusyClaimsForSessionInTransaction(
        tx,
        context,
        unit.sessionId,
        now,
      );
    const [part] = await tx
      .select({
        id: billSplits.id,
        sealed: billSplits.claimTokenSealed,
        expiresAt: sql<Date | null>`COALESCE((SELECT resume_deadline FROM loyalty_claim_pauses WHERE tenant_id = ${tenantId} AND split_id = ${billSplits.id} AND state = 'active'), ${billSplits.claimExpiresAt})`,
        orderId: billSplits.orderId,
        orderStatus: orders.status,
      })
      .from(billSplits)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, billSplits.tenantId),
          eq(orders.id, billSplits.orderId),
        ),
      )
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.claimTokenHash, sha256(rawToken)),
          eq(billSplits.status, "paid"),
          isNull(billSplits.claimRedeemedAt),
          sql`NOT EXISTS (SELECT 1 FROM loyalty_claim_pauses p WHERE p.tenant_id = ${tenantId} AND p.split_id = ${billSplits.id} AND p.state <> 'active')`,
          sql`COALESCE((SELECT resume_deadline FROM loyalty_claim_pauses WHERE tenant_id = ${tenantId} AND split_id = ${billSplits.id} AND state = 'active'), ${billSplits.claimExpiresAt}) > ${now}`,
        ),
      );
    if (!part || part.sealed === null || part.expiresAt === null)
      throw notFound();
    if (part.orderStatus === "voided") throw notFound();
    if (await orderBlocksClaim(tx, tenantId, part.orderId)) throw notFound();
    return splitClaimSchema.parse({
      billSplitId: part.id,
      status: "available",
      claimToken: openSecret(part.sealed, claimAad(tenantId, part.id)),
      claimableUntil: toIsoDateTime(new Date(part.expiresAt)),
    });
  });
}
