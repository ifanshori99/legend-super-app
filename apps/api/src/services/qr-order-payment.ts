// Pay-first payment hand-off and kitchen fire for QR orders (bead legend-e2x;
// PRD v1.7 §3 F10 "Mode Bayar", §4 Alur A steps 5-6; ORD-02).
//
// PRD Alur A: "Pelanggan memilih metode pembayaran; server membuat payment
// intent ... Setelah webhook terverifikasi diterima, pesanan diteruskan ke KDS".
//
// - `createGuestPayment` (contract guest.ts `createGuestPayment`, target
//   `order`) opens one WS-05 payment link per order (lazily, the first time a
//   guest pays) and one live intent for it. The amount is the order total less
//   the applied reservation deposit, computed by the server (PAY-01, ORD-03).
//   Two guests paying the same order serialize on the order row: the second
//   one receives the same live intent instead of a second one.
// - Methods are QRIS and VA (legend-3160, CTO decision 9 Nov). A VA names a
//   bank from the gateway's channel list (`getGuestPaymentOptions`); picking
//   another method or bank opens a new intent, which supersedes the pending
//   one on the same WS-05 link (createIntent: one live code per bill).
// - WS-05 `payment.paid` (appended only by `confirmPayment` after verified
//   evidence, PAY-02) is consumed from the outbox by
//   `deliverOrderPaymentEvent` (order-payment-consumers), which fires the
//   order through `handleQrOrderPaymentPaid`. `deliverQrOrderPaymentEvent` is
//   a thin compatibility delegate to the same handler, kept for tests.
//   Nothing else can fire a pay-first order, so no item reaches the KDS
//   before a verified payment (ORD-02).

import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  CoreError,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type { CustomerPaymentIntent } from "@starter/shared/payment";
import {
  createGuestPaymentInputSchema,
  guestPaymentSchema,
  guestPaymentTargetSchema,
  guestPaymentOptionsSchema,
  tableSessionTokenExpiresAt,
  type GuestPayment,
  type GuestPaymentMethod,
  type GuestPaymentOptions,
} from "@starter/shared/qr-order";
import { z } from "@starter/shared/core";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { billSplits } from "../db/schema/bill-splits.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";
import {
  expiredCodeMayStillPay,
  failedCodeMayStillPay,
  noClosedHold,
} from "./payment-live-code.ts";
import { selectGatewayForNewIntent } from "./payment-gateway-select.ts";
import { resolveRoutingRule } from "./payment-routing.service.ts";
import {
  assertSplitMutableTx,
  listLiveSplitsTx,
  lockSplitPartTx,
  partLiveCodeTx,
  voidLiveSplitsTx,
} from "./bill-split.service.ts";
import {
  createIntent,
  createPaymentLink,
  createSplitPartIntent,
  getIntentView,
  readIntentView,
} from "./payment.service.ts";
import {
  failedOrderCodeWithOpenFundTx,
  failedPartCodeWithOpenFundTx,
} from "./payment-failed-funds.ts";
import { hasOpenEdcRequest } from "./pos-order-support.ts";
import {
  activeHoldOf,
  openGuestQrisHold,
  openSplitQrisHold,
} from "./pos-qris-hold.ts";
import { handleQrOrderPaymentPaid } from "./qr-order-consumers.ts";
import {
  loadQrZoneOfSession,
  lockGuestSessionForPayment,
  qrOrderIdempotent,
  type QrOrderRow,
} from "./qr-order.service.ts";

type CreateGuestPaymentInput = z.output<typeof createGuestPaymentInputSchema>;

/** `payment_links.created_by` is free text; QR guests are not users. */
const LINK_CREATED_BY = "system:qr-order";

function linkSealAad(tenantId: string, orderId: string): string {
  return `qr-order-payment-link:${tenantId}:${orderId}`;
}

/** legend-i83ls: the sealed link token of a swap-difference charge. */
export function chargeLinkSealAad(tenantId: string, chargeId: string): string {
  return `order-issue-charge-link:${tenantId}:${chargeId}`;
}

export function guestPaymentDto(
  intent: CustomerPaymentIntent,
  target: z.input<typeof guestPaymentTargetSchema>,
): GuestPayment {
  const { instructions } = intent;
  // Only QRIS and VA intents are opened for a QR order.
  if (instructions.method !== "qris" && instructions.method !== "va")
    throw new Error("QR order payment has an unsupported method");
  const va = instructions.method === "va" ? instructions : null;
  return guestPaymentSchema.parse({
    id: intent.id,
    target,
    method: instructions.method,
    amountIdr: intent.amountIdr,
    status: intent.status,
    qrisPayload: instructions.method === "qris" ? instructions.qrPayload : null,
    redirectUrl: null,
    vaNumber: va?.virtualAccountNumber ?? null,
    bankCode: va?.channelCode ?? null,
    bankName: va?.channelName ?? null,
    expiresAt: intent.expiresAt,
    paidAt: intent.status === "paid" ? intent.paidAt : null,
  });
}

async function lockSessionOrder(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  orderId: string,
): Promise<QrOrderRow> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.id, orderId),
        eq(orders.tableSessionId, sessionId),
      ),
    )
    .for("update");
  if (!order) throw new CoreError("NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.channel !== "qr" || order.paymentMode !== "pay_first")
    throw new CoreError(
      "CONFLICT",
      "Pesanan ini dibayar melalui kasir, bukan pembayaran tamu.",
    );
  return order;
}

function linkToken(context: ScopedTenantContext, order: QrOrderRow): string {
  if (order.paymentLinkTokenSealed === null)
    throw new Error("Payment link token missing");
  return openSecret(
    order.paymentLinkTokenSealed,
    linkSealAad(context.tenant.tenantId, order.id),
  );
}

/**
 * Step 1: the order's WS-05 bill, opened once. The link is created through
 * `createPaymentLink` (its own transaction) while this transaction holds the
 * order row, so concurrent payers never open two bills for one order.
 * Returns the session's outlet (the gateway picks that outlet's account).
 */
async function ensurePaymentLink(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  orderId: string,
  now: Date,
): Promise<string> {
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const order = await lockSessionOrder(tx, context, session.id, orderId);
    if (order.status !== "awaiting_payment")
      throw new CoreError(
        "CONFLICT",
        order.status === "voided"
          ? "Pesanan ini sudah dibatalkan."
          : "Pesanan ini tidak menunggu pembayaran.",
      );
    if (order.paymentLinkId !== null) return session.outletId;
    const { tableCode } = await loadQrZoneOfSession(tx, context, session);
    const payable = order.totalIdr - order.depositAppliedIdr;
    // The deposit is shown as a reduction of the bill: the link's total is
    // what the guest still owes (PAY-01: the amount is the server's).
    const opened = await createPaymentLink(
      context,
      {
        outletId: order.outletId,
        reference: order.number,
        tableLabel: tableCode,
        pax: session.pax,
        // legend-zmc2: an inclusive order's subtotal already contains the
        // service charge and tax; the link adds them, so it gets the subtotal
        // without them (same total, payment_links_total_check holds).
        subtotalIdr: orderNetSubtotalIdr(order),
        discountIdr: order.discountIdr + order.depositAppliedIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        taxIdr: order.taxIdr,
        roundingIdr: order.roundingIdr,
        totalIdr: payable,
        returnPath: null,
      },
      LINK_CREATED_BY,
      now,
    );
    await tx
      .update(orders)
      .set({
        paymentLinkId: opened.linkId,
        paymentLinkTokenSealed: sealSecret(
          opened.token,
          linkSealAad(context.tenant.tenantId, order.id),
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.id, order.id),
        ),
      );
    return session.outletId;
  });
}

/** True when the live intent is the method and bank the guest asks for. */
export function sameChoice(
  intent: CustomerPaymentIntent,
  method: GuestPaymentMethod,
  bankCode: string | null,
): boolean {
  if (intent.instructions.method !== method) return false;
  return (
    intent.instructions.method !== "va" ||
    intent.instructions.channelCode === bankCode
  );
}

/**
 * A VA bank must be one the gateway lists right now (PRD §3.13 "Metode DOIT":
 * the list comes from the provider, never from the client).
 */
export async function assertVaBank(
  context: ScopedTenantContext,
  bankCode: string,
  outletId: string,
): Promise<void> {
  // The gateway the VA rule routes to now (fallback when the primary is down).
  const routing = await withTenant(db, context, (tx) =>
    resolveRoutingRule(tx, context, outletId, "va"),
  );
  const selected = await selectGatewayForNewIntent(context, outletId, routing);
  const port = selected.provider
    ? selected.port
    : paymentGatewayFor(routing.provider);
  const banks = await port.channels(context, "va", outletId);
  if (!banks.some((bank) => bank.code === bankCode))
    throw new CoreError(
      "VALIDATION_ERROR",
      "Bank virtual account ini tidak tersedia; pilih bank lain.",
    );
}

/**
 * GET /api/table-sessions/:sessionId/payment-options (contract guest.ts).
 * QRIS and VA with the outlet's routing and the gateway's health; VA lists
 * the banks the gateway offers and is off when it offers none.
 */
export async function getGuestPaymentOptions(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now = new Date(),
): Promise<GuestPaymentOptions> {
  const routed = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const rules = [];
    for (const method of ["qris", "va"] as const) {
      const rule = await resolveRoutingRule(
        tx,
        context,
        session.outletId,
        method,
      );
      rules.push({ method, routing: rule });
    }
    return { outletId: session.outletId, rules };
  });
  const methods = [];
  for (const entry of routed.rules) {
    const selected = await selectGatewayForNewIntent(
      context,
      routed.outletId,
      entry.routing,
    );
    const gatewayUsable = selected.provider !== null;
    const banks =
      entry.method === "va" && entry.routing.enabled && selected.provider
        ? await selected.port.channels(context, "va", routed.outletId)
        : [];
    const configured = entry.method === "qris" || banks.length > 0;
    const enabled = entry.routing.enabled && gatewayUsable && configured;
    methods.push({
      method: entry.method,
      enabled,
      unavailableReason: enabled
        ? null
        : !entry.routing.enabled
          ? ("routing_disabled" as const)
          : !gatewayUsable
            ? ("gateway_down" as const)
            : ("no_channels" as const),
      banks,
    });
  }
  return guestPaymentOptionsSchema.parse({ methods });
}

function payerSecretHash(secret: string | undefined): string {
  if (secret === undefined)
    throw new Error("Split payment has no payer secret");
  return createHash("sha256").update(secret).digest("hex");
}

function sameHash(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * legend-kf104: the whole-order code of the bill that may still take money:
 * any `pending` code (a lapsed one stays pending until the gateway answers),
 * or an `expired` one the gateway received until the PROVIDER answered final
 * or its money was reconciled (SO-885, `expiredCodeMayStillPay`: the gateway
 * cancel is best effort and a local timeout is not proof). A code whose QR
 * hold the provider proved dead (hold `closed`) is dead. Same rule as
 * `partLiveCodeTx` for a split part, so a VA, a bank change or a QR never
 * replaces a code that may still be paid (two collectible codes of one bill).
 */
async function orderLiveCodeTx(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string,
): Promise<{ id: string } | null> {
  const tenantId = context.tenant.tenantId;
  const [code] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        isNull(paymentIntents.billSplitId),
        or(
          and(eq(paymentIntents.status, "pending"), noClosedHold),
          expiredCodeMayStillPay(),
          failedCodeMayStillPay(),
        ),
      ),
    )
    .orderBy(desc(paymentIntents.createdAt))
    .limit(1);
  return code ?? null;
}

/**
 * legend-w0ows: a QR may not be issued while a card sale of the bill is open
 * (the card wins, founder Q7). Takes the bill's EDC advisory lock, the lock the
 * edge write-ahead and `addPosTender` take, after the order row lock (same
 * order as `addPosTender`), so a sale that already passed the agent's hold
 * check never meets a hold born after it.
 */
async function assertNoOpenCardSale(
  tx: Tx,
  context: ScopedTenantContext,
  order: Pick<typeof orders.$inferSelect, "outletId" | "number">,
): Promise<void> {
  if (await hasOpenEdcRequest(tx, context, order))
    throw new HttpError(
      409,
      "EDC_REQUEST_OPEN",
      "Ada pembayaran kartu yang sedang berjalan untuk tagihan ini. Selesaikan dulu.",
    );
}

/**
 * legend-eqeu7: the provider status call and the settlement of a paid answer
 * (`getIntentView` -> `applyConfirmation`, which waits for the order row lock)
 * run here, before the transaction that locks the order. A code that went
 * paid at the provider (lost webhook) is settled now; the locked transaction
 * then reads the stored state again (`readIntentView`) and never calls out.
 * Reads only: no row is locked, so nothing here can wait on the caller.
 */
async function syncCodesOutsideLock(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  orderId: string,
  splitId: string | null,
  now: Date,
): Promise<void> {
  const found = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.id, orderId),
          eq(orders.tableSessionId, session.id),
        ),
      );
    if (!order || order.paymentLinkTokenSealed === null) return null;
    const codeIds = new Set<string>();
    if (splitId === null) {
      if (order.paymentIntentId !== null) codeIds.add(order.paymentIntentId);
    } else {
      const [part] = await tx
        .select()
        .from(billSplits)
        .where(
          and(
            eq(billSplits.tenantId, context.tenant.tenantId),
            eq(billSplits.id, splitId),
            eq(billSplits.tableSessionId, session.id),
          ),
        );
      if (part?.paymentIntentId) codeIds.add(part.paymentIntentId);
      if (part) {
        const live = await partLiveCodeTx(tx, context, part.id);
        if (live !== null) codeIds.add(live.id);
      }
    }
    return { token: linkToken(context, order), codeIds: [...codeIds] };
  });
  if (found === null) return;
  for (const codeId of found.codeIds)
    await getIntentView(context, found.token, codeId, now);
}

/**
 * POST /api/table-sessions/:sessionId/payments (contract guest.ts). The
 * pay-first `order` and the split `split` targets are live, with QRIS or VA:
 * the open-bill `bill` target belongs to the bill settlement bead.
 */
export async function createGuestPayment(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: CreateGuestPaymentInput,
  now = new Date(),
): Promise<GuestPayment> {
  const parsed = createGuestPaymentInputSchema.parse(input);
  if (parsed.target.kind === "bill")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pembayaran tagihan open bill belum tersedia di sini.",
    );
  if (parsed.target.kind === "issue_charge")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Selisih swap dibayar lewat tagihannya sendiri.",
    );
  const bankCode = parsed.method === "va" ? (parsed.bankCode ?? null) : null;
  // A split share pays into its order's bill: find the order first.
  const target = parsed.target;
  const splitId = target.kind === "split" ? target.billSplitId : null;
  const orderId =
    target.kind === "order"
      ? target.orderId
      : await withTenant(db, context, async (tx) => {
          const session = await lockGuestSessionForPayment(
            tx,
            context,
            credential,
            sessionId,
            now,
            "share",
          );
          return (
            await lockSplitPartTx(tx, context, session.id, target.billSplitId)
          ).orderId;
        });
  const outletId = await ensurePaymentLink(
    context,
    credential,
    sessionId,
    orderId,
    now,
  );
  await syncCodesOutsideLock(
    context,
    credential,
    sessionId,
    orderId,
    splitId,
    now,
  );
  // Checked after the session lock so the outlet's own channel list decides.
  if (bankCode !== null) await assertVaBank(context, bankCode, outletId);
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const { idempotencyKey, ...request } = parsed;
    return qrOrderIdempotent(
      tx,
      context,
      { sessionId: session.id, outletId: session.outletId },
      idempotencyKey,
      "payment.create",
      request,
      async () => {
        const order = await lockSessionOrder(tx, context, session.id, orderId);
        // Lock order: session -> order -> bill_splits -> link.
        const part =
          splitId === null
            ? null
            : await lockSplitPartTx(tx, context, session.id, splitId);
        if (part !== null && part.status === "voided")
          throw new CoreError("CONFLICT", "Bagian tagihan ini sudah diganti.");
        const token = linkToken(context, order);
        // legend-r77pq: only the payer (the secret that opened the part) gets
        // its intent. Anyone else never receives an intent or its id.
        const secretHash =
          part === null ? null : payerSecretHash(parsed.payerSecret);
        let payer = true;
        if (part !== null && secretHash !== null) {
          payer =
            part.payerSecretHash !== null
              ? sameHash(part.payerSecretHash, secretHash)
              : part.paymentIntentId === null;
          if (!payer) {
            const current =
              part.paymentIntentId === null
                ? null
                : await readIntentView(
                    context,
                    token,
                    part.paymentIntentId,
                    now,
                  );
            if (part.status === "paid" || current?.status === "paid")
              throw new HttpError(
                409,
                "SPLIT_PART_PAID",
                "Bagian tagihan ini sudah dibayar oleh tamu lain.",
              );
            if ((await partLiveCodeTx(tx, context, part.id)) !== null)
              throw new HttpError(
                409,
                "SPLIT_CODE_ACTIVE",
                "Bagian tagihan ini sedang dibayar tamu lain; tunggu sampai kodenya berakhir.",
              );
            // The old code is dead: this guest takes the part over below.
          }
        }
        if (part !== null && part.status === "paid") {
          if (part.paymentIntentId === null)
            throw new Error("Paid split part has no payment intent");
          return guestPaymentDto(
            await readIntentView(context, token, part.paymentIntentId, now),
            { kind: "split", billSplitId: part.id },
          );
        }
        if (order.status !== "awaiting_payment")
          throw new CoreError(
            "CONFLICT",
            "Pesanan ini tidak menunggu pembayaran.",
          );
        if (part !== null) {
          // One payable code per part: the same method and bank returns the
          // pending intent; another choice waits until the old code is dead
          // (expired and past the late-payment grace), so two codes of one
          // part can never both be paid.
          if (payer && part.paymentIntentId !== null) {
            const current = await readIntentView(
              context,
              token,
              part.paymentIntentId,
              now,
            );
            if (
              current.status === "paid" ||
              (current.status === "pending" &&
                sameChoice(current, parsed.method, bankCode))
            )
              return guestPaymentDto(current, {
                kind: "split",
                billSplitId: part.id,
              });
          }
          const live = payer
            ? await partLiveCodeTx(tx, context, part.id)
            : null;
          if (live !== null) {
            // No payer hash yet means no payer: a live code here is an orphan
            // (its creating transaction rolled back), so nobody gets it.
            if (
              part.payerSecretHash !== null &&
              live.status === "pending" &&
              live.method === parsed.method &&
              (parsed.method !== "va" || live.channelCode === bankCode)
            )
              return guestPaymentDto(
                await readIntentView(context, token, live.id, now),
                { kind: "split", billSplitId: part.id },
              );
            throw new HttpError(
              409,
              "SPLIT_CODE_ACTIVE",
              "Kode pembayaran bagian ini masih berlaku; selesaikan atau tunggu sampai berakhir.",
            );
          }
          // legend-yhia9: one collectible QRIS per bill. A live code of this
          // part was answered above; a QR of another part (or a dead code the
          // provider has not yet confirmed closed) refuses a new one.
          if (
            parsed.method === "qris" &&
            (await activeHoldOf(tx, context.tenant.tenantId, order.id))
          )
            throw new HttpError(
              409,
              "QRIS_HOLD_ACTIVE",
              "QR bagian lain masih bisa dibayar. Tunggu sampai dibayar atau berakhir dulu.",
            );
          // SO-885 legend-0owye: money of a failed code of this part is still
          // parked; the part is not charged again before it is returned.
          if (
            await failedPartCodeWithOpenFundTx(
              tx,
              context.tenant.tenantId,
              part.id,
            )
          )
            throw new HttpError(
              409,
              "FUNDS_UNRESOLVED",
              "Uang dari pembayaran sebelumnya belum dikembalikan; selesaikan dulu sebelum membayar lagi.",
            );
          if (parsed.method === "qris")
            await assertNoOpenCardSale(tx, context, order);
          const intent = await createSplitPartIntent(
            context,
            token,
            {
              method: parsed.method,
              channelCode: bankCode,
              idempotencyKey: `qrs-${createHash("sha256")
                .update(`${order.id}:${part.id}:${idempotencyKey}`)
                .digest("hex")
                .slice(0, 48)}`,
              expiresAt: tableSessionTokenExpiresAt({
                openedAt: session.openedAt.toISOString(),
                closedAt: session.closedAt?.toISOString() ?? null,
              }),
            },
            { billSplitId: part.id, amountIdr: part.amountIdr },
            now,
          );
          if (parsed.method === "qris")
            await openSplitQrisHold(tx, {
              order,
              billSplitId: part.id,
              intentId: intent.id,
              amount: part.amountIdr,
              now,
            });
          // Never `orders.paymentIntentId`: that is the whole-order code.
          await tx
            .update(billSplits)
            .set({
              paymentIntentId: intent.id,
              // First intent makes this guest the payer; a takeover of a dead
              // code replaces the old payer's hash.
              payerSecretHash: secretHash,
              updatedAt: now,
            })
            .where(
              and(
                eq(billSplits.tenantId, context.tenant.tenantId),
                eq(billSplits.id, part.id),
              ),
            );
          return guestPaymentDto(intent, {
            kind: "split",
            billSplitId: part.id,
          });
        }
        // Paying the whole order replaces a split that nobody has paid or
        // started paying (assertSplitMutableTx throws SPLIT_LOCKED otherwise).
        if ((await listLiveSplitsTx(tx, context, order.id)).length > 0) {
          await assertSplitMutableTx(tx, context, order);
          await voidLiveSplitsTx(tx, context, order.id, now);
        }
        // One live code per order: a second payer asking for the same
        // method and bank gets the pending intent; another method or bank
        // opens a new one, which supersedes it (createIntent).
        if (order.paymentIntentId !== null) {
          const current = await readIntentView(
            context,
            token,
            order.paymentIntentId,
            now,
          );
          if (
            current.status === "paid" ||
            (current.status === "pending" &&
              sameChoice(current, parsed.method, bankCode))
          )
            return guestPaymentDto(current, {
              kind: "order",
              orderId: order.id,
            });
        }
        // legend-kf104: one collectible code per bill, like a split part. A
        // code the guest switched away from may still be paid at the provider,
        // so a replacement waits until the hold check proved it dead.
        if (await activeHoldOf(tx, context.tenant.tenantId, order.id))
          throw new HttpError(
            409,
            "QRIS_HOLD_ACTIVE",
            "Kode QR sebelumnya masih bisa dibayar. Tunggu sampai dibayar atau berakhir dulu.",
          );
        // A VA (no hold), or a code past its expiry that the gateway may
        // still accept, is held to the same rule: no replacement while it may
        // be paid, whatever method the guest now asks for.
        if (
          order.paymentLinkId !== null &&
          (await orderLiveCodeTx(tx, context, order.paymentLinkId))
        )
          throw new HttpError(
            409,
            "ORDER_CODE_ACTIVE",
            "Kode pembayaran sebelumnya masih berlaku; selesaikan atau tunggu sampai berakhir.",
          );
        // SO-885 legend-0owye: a code closed `failed` by an amount mismatch
        // still has the guest's money parked; no new code until it is returned.
        if (
          await failedOrderCodeWithOpenFundTx(
            tx,
            context.tenant.tenantId,
            order,
          )
        )
          throw new HttpError(
            409,
            "FUNDS_UNRESOLVED",
            "Uang dari pembayaran sebelumnya belum dikembalikan; selesaikan dulu sebelum membayar lagi.",
          );
        if (parsed.method === "qris")
          await assertNoOpenCardSale(tx, context, order);
        // The WS-05 key is unique per tenant; derive it from the order so a
        // guest key can never collide with another session's payment.
        const intent = await createIntent(
          context,
          token,
          {
            method: parsed.method,
            channelCode: bankCode,
            idempotencyKey: `qro-${createHash("sha256")
              .update(`${order.id}:${idempotencyKey}`)
              .digest("hex")
              .slice(0, 48)}`,
            // A code never outlives the guest's session credential; WS-05
            // caps it at the method default (VA 180 minutes).
            expiresAt: tableSessionTokenExpiresAt({
              openedAt: session.openedAt.toISOString(),
              closedAt: session.closedAt?.toISOString() ?? null,
            }),
          },
          now,
        );
        if (parsed.method === "qris")
          await openGuestQrisHold(tx, {
            order,
            billSplitId: null,
            intentId: intent.id,
            amount: intent.amountIdr,
            now,
          });
        await tx
          .update(orders)
          .set({ paymentIntentId: intent.id, updatedAt: now })
          .where(
            and(
              eq(orders.tenantId, context.tenant.tenantId),
              eq(orders.id, order.id),
            ),
          );
        return guestPaymentDto(intent, { kind: "order", orderId: order.id });
      },
    );
  });
}

/** GET /api/table-sessions/:sessionId/payments/:paymentId (status poll). */
export async function getGuestPayment(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  paymentId: string,
  now = new Date(),
): Promise<GuestPayment> {
  const intentId = uuidSchema.parse(paymentId);
  const found = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    // Through the intent's bill, not `orders.paymentIntentId`: a code the
    // guest switched away from (superseded) still answers with its status.
    const [intent] = await tx
      .select({
        paymentLinkId: paymentIntents.paymentLinkId,
        billSplitId: paymentIntents.billSplitId,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    const [order] = intent
      ? await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, context.tenant.tenantId),
              eq(orders.tableSessionId, session.id),
              eq(orders.paymentLinkId, intent.paymentLinkId),
            ),
          )
      : [];
    // legend-i83ls: the intent may belong to a swap-difference charge link.
    const [charge] =
      intent && !order
        ? await tx
            .select({
              id: orderIssueCharges.id,
              sealed: orderIssueCharges.paymentLinkTokenSealed,
            })
            .from(orderIssueCharges)
            .where(
              and(
                eq(orderIssueCharges.tenantId, context.tenant.tenantId),
                eq(orderIssueCharges.tableSessionId, session.id),
                eq(orderIssueCharges.paymentLinkId, intent.paymentLinkId),
              ),
            )
        : [];
    if (charge?.sealed)
      return {
        target: { kind: "issue_charge", chargeId: charge.id } as z.input<
          typeof guestPaymentTargetSchema
        >,
        token: openSecret(
          charge.sealed,
          chargeLinkSealAad(context.tenant.tenantId, charge.id),
        ),
      };
    if (!order || order.paymentLinkTokenSealed === null)
      throw new CoreError("NOT_FOUND", "Pembayaran tidak ditemukan.");
    return {
      target: (intent?.billSplitId
        ? { kind: "split", billSplitId: intent.billSplitId }
        : { kind: "order", orderId: order.id }) as z.input<
        typeof guestPaymentTargetSchema
      >,
      token: linkToken(context, order),
    };
  });
  const intent = await getIntentView(context, found.token, intentId, now);
  return guestPaymentDto(intent, found.target);
}

// ---- Kitchen fire on verified payment (ORD-02) --------------------------------------

/**
 * Entry point for WS-05 `payment.paid` of a QR order. Delegates to
 * `handleQrOrderPaymentPaid` (qr-order-consumers.ts), the consumer that
 * `deliverOrderPaymentEvent` routes QR bills to, so there is one decision
 * path: the fire is re-read from the locked rows (link total equals the quote
 * amount due, link fully paid, a `paid` intent, IDR) and a replay or a late
 * payment on a voided order changes nothing here. Runs in the consumption
 * transaction (core-outbox.ts `consumeOutbox`), so the fire commits with the
 * consumed offset. Returns true only when this call fired the order.
 */
export async function deliverQrOrderPaymentEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  _idempotencyKey: string,
  tx: Tx,
  now = new Date(),
): Promise<boolean> {
  return (await handleQrOrderPaymentPaid(context, event, tx, now)) === "fired";
}
