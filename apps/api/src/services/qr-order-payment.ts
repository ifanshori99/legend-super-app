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
// - Methods are QRIS and VA (legend-3160, CTO decision 9 Nov), plus Duitku
//   e-wallet and card (legend-kt3t1). A VA or e-wallet names a channel from the
//   gateway's channel list (`getGuestPaymentOptions`); a card takes none and is
//   answered with a redirect URL. Picking another method or channel opens a new
//   intent, which supersedes the pending one on the same WS-05 link
//   (createIntent: one live code per bill).
// - WS-05 `payment.paid` (appended only by `confirmPayment` after verified
//   evidence, PAY-02) is consumed from the outbox by
//   `deliverOrderPaymentEvent` (order-payment-consumers), which fires the
//   order through `handleQrOrderPaymentPaid`. `deliverQrOrderPaymentEvent` is
//   a thin compatibility delegate to the same handler, kept for tests.
//   Nothing else can fire a pay-first order, so no item reaches the KDS
//   before a verified payment (ORD-02).

import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CoreError,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type {
  CustomerPaymentIntent,
  PaymentChannel,
} from "@starter/shared/payment";
import {
  createGuestPaymentInputSchema,
  GUEST_PAYMENT_METHODS,
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
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { billSplits } from "../db/schema/bill-splits.ts";
import { orders, qrOrderIdempotency } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import {
  paymentGatewayFor,
  type PaymentGatewayPort,
} from "./payment-gateway.ts";
import { liveCodeWhere } from "./payment-live-code.ts";
import { outstandingIdr } from "./payment-support.ts";
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
import { voidLiveCodesForMethodChange } from "./payment-va-release.ts";
import { handleQrOrderPaymentPaid } from "./qr-order-consumers.ts";
import {
  loadQrZoneOfSession,
  lockGuestSessionForPayment,
  qrOrderIdempotent,
  qrOrderPeekIdempotent,
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
  // Only QRIS, VA, e-wallet and card intents are opened for a QR order.
  if (instructions.method === "bank_transfer")
    throw new Error("QR order payment has an unsupported method");
  const va = instructions.method === "va" ? instructions : null;
  const redirect =
    instructions.method === "ewallet" || instructions.method === "card"
      ? instructions
      : null;
  // A card names no channel to the guest (the gateway's code stays internal).
  const channel =
    instructions.method === "va" || instructions.method === "ewallet"
      ? instructions
      : null;
  return guestPaymentSchema.parse({
    id: intent.id,
    target,
    method: instructions.method,
    amountIdr: intent.amountIdr,
    status: intent.status,
    qrisPayload: instructions.method === "qris" ? instructions.qrPayload : null,
    // legend-kt3t1: a voided, expired or failed code never exposes its pay link.
    redirectUrl:
      intent.status === "pending" ? (redirect?.paymentUrl ?? null) : null,
    vaNumber: va?.virtualAccountNumber ?? null,
    bankCode: channel?.channelCode ?? null,
    bankName: channel?.channelName ?? null,
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

/** A VA or an e-wallet names a channel; QRIS and card do not. */
function namesChannel(method: GuestPaymentMethod): method is "va" | "ewallet" {
  return method === "va" || method === "ewallet";
}

/**
 * True when the live intent is the method and bank the guest asks for. A card
 * is compared by method only (it has no channel of the guest's choosing).
 */
export function sameChoice(
  intent: CustomerPaymentIntent,
  method: GuestPaymentMethod,
  bankCode: string | null,
): boolean {
  const { instructions } = intent;
  if (instructions.method !== method) return false;
  return (
    (instructions.method !== "va" && instructions.method !== "ewallet") ||
    instructions.channelCode === bankCode
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
  await assertGuestChannel(context, "va", bankCode, outletId);
}

/**
 * legend-kt3t1: the same check for any channel-bearing method (VA bank or
 * e-wallet). The list is the one the gateway the method's rule routes to
 * reports now, never the client's.
 */
export async function assertGuestChannel(
  context: ScopedTenantContext,
  method: "va" | "ewallet",
  code: string,
  outletId: string,
  amountIdr?: number,
): Promise<void> {
  // The gateway the rule routes to now (fallback when the primary is down).
  const routing = await withTenant(db, context, (tx) =>
    resolveRoutingRule(tx, context, outletId, method),
  );
  const selected = await selectGatewayForNewIntent(context, outletId, routing);
  const port = selected.provider
    ? selected.port
    : paymentGatewayFor(routing.provider);
  // An e-wallet is checked at the real bill amount (it can be out of limits
  // for it); a gateway without `methods()` answers from `channels()`.
  let channels: readonly PaymentChannel[];
  if (method === "ewallet" && amountIdr !== undefined && port.methods) {
    const listed = await port.methods(context, outletId, amountIdr);
    channels =
      listed.find((entry) => entry.method === method && entry.enabled)
        ?.channels ?? [];
  } else channels = await port.channels(context, method, outletId);
  if (!channels.some((channel) => channel.code === code))
    throw new CoreError(
      "VALIDATION_ERROR",
      method === "va"
        ? "Bank virtual account ini tidak tersedia; pilih bank lain."
        : "E-wallet ini tidak tersedia; pilih e-wallet lain.",
    );
}

/**
 * legend-kt3t1: does the gateway list this method as enabled right now? Read
 * from the provider's own `methods()` (PRD §3.13), never from a fixed list.
 * A gateway without `methods()` (a test double) offers QRIS and VA, whose
 * channel list decides, and never e-wallet or card. A failed read is "no".
 */
async function gatewayListsMethod(
  context: ScopedTenantContext,
  port: PaymentGatewayPort,
  method: GuestPaymentMethod,
  outletId: string,
  amountIdr?: number,
): Promise<boolean> {
  if (port.methods === undefined) return method === "qris" || method === "va";
  try {
    const listed = await port.methods(context, outletId, amountIdr);
    return listed.some((entry) => entry.method === method && entry.enabled);
  } catch {
    return false;
  }
}

/**
 * legend-kt3t1: an e-wallet or card is refused unless the tenant's gateway for
 * that method lists it as enabled (and its routing rule is on). Throws
 * VALIDATION_ERROR; nothing is created. `amountIdr` is the bill amount read
 * server-side (never the guest's), so a method over its limit is refused before
 * any old code is voided.
 */
async function assertGuestMethodOffered(
  context: ScopedTenantContext,
  method: "ewallet" | "card",
  outletId: string,
  amountIdr: number,
): Promise<void> {
  const routing = await withTenant(db, context, (tx) =>
    resolveRoutingRule(tx, context, outletId, method),
  );
  const selected = await selectGatewayForNewIntent(context, outletId, routing);
  if (
    !routing.enabled ||
    selected.provider === null ||
    !(await gatewayListsMethod(
      context,
      selected.port,
      method,
      outletId,
      amountIdr,
    ))
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Metode pembayaran ini tidak tersedia di outlet ini.",
    );
}

/**
 * GET /api/table-sessions/:sessionId/payment-options (contract guest.ts).
 * Every guest method with the outlet's routing and the gateway's health; a
 * method is on only if the gateway lists it. VA and e-wallet list the channels
 * the gateway offers and are off when it offers none.
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
    for (const method of GUEST_PAYMENT_METHODS) {
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
    const entryMethod = entry.method;
    const banks =
      namesChannel(entryMethod) && entry.routing.enabled && selected.provider
        ? await selected.port.channels(context, entryMethod, routed.outletId)
        : [];
    const listed =
      entry.routing.enabled && selected.provider !== null
        ? await gatewayListsMethod(
            context,
            selected.port,
            entryMethod,
            routed.outletId,
          )
        : false;
    const configured =
      listed && (!namesChannel(entryMethod) || banks.length > 0);
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
): Promise<{
  id: string;
  method: string;
  channelCode: string | null;
  status: string;
} | null> {
  const tenantId = context.tenant.tenantId;
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
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        isNull(paymentIntents.billSplitId),
        liveCodeWhere(),
      ),
    )
    .orderBy(desc(paymentIntents.createdAt))
    .limit(1);
  return code ?? null;
}

/**
 * The WS-05 key of a guest's whole-order code. Unique per tenant, so it is
 * derived from the order: a guest key can never collide with another
 * session's payment.
 */
function orderIntentKey(orderId: string, idempotencyKey: string): string {
  return `qro-${createHash("sha256")
    .update(`${orderId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 48)}`;
}

/** The WS-05 key of a guest's split part code (see `orderIntentKey`). */
function partIntentKey(
  orderId: string,
  partId: string,
  idempotencyKey: string,
): string {
  return `qrs-${createHash("sha256")
    .update(`${orderId}:${partId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 48)}`;
}

/**
 * legend-9vmit (founder Q15): a guest who switches method or bank gets the old
 * VA / bank transfer code voided first, outside the main transaction, because
 * the void reads the provider over the network and commits its own release row
 * (`voidLiveCodesForMethodChange`). The main transaction then finds the old
 * code no longer live, so the new code can be issued. This only decides
 * whether to void; every refusal stays in the main transaction as before:
 * a replay of this request, the same choice (answered with the pending code),
 * a QRIS code (hold rules), and a non-payer of a split part all skip it. A
 * provider-side failure throws the void's HttpError to the guest.
 */
async function voidOldCodesForChange(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  orderId: string,
  splitId: string | null,
  request: {
    method: GuestPaymentMethod;
    bankCode: string | null;
    payerSecret: string | undefined;
    idempotencyKey: string;
  },
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const scope = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.id, orderId),
          eq(orders.tableSessionId, session.id),
        ),
      );
    if (
      !order ||
      order.paymentLinkId === null ||
      order.status !== "awaiting_payment"
    )
      return null;
    // A replay of this request (its answer is stored, which may be another
    // guest's code): never void anything on its behalf, the stored answer is
    // served by the main transaction as it is.
    const [stored] = await tx
      .select({ key: qrOrderIdempotency.key })
      .from(qrOrderIdempotency)
      .where(
        and(
          eq(qrOrderIdempotency.tenantId, tenantId),
          eq(qrOrderIdempotency.tableSessionId, session.id),
          eq(qrOrderIdempotency.key, request.idempotencyKey),
        ),
      );
    if (stored) return null;
    let intentKey: string;
    let live: Awaited<ReturnType<typeof orderLiveCodeTx>>;
    if (splitId === null) {
      intentKey = orderIntentKey(order.id, request.idempotencyKey);
      live = await orderLiveCodeTx(tx, context, order.paymentLinkId);
    } else {
      const part = await lockSplitPartTx(tx, context, session.id, splitId);
      // Only the payer who opened the part may swap its code.
      if (
        request.payerSecret === undefined ||
        part.payerSecretHash === null ||
        !sameHash(part.payerSecretHash, payerSecretHash(request.payerSecret))
      )
        return null;
      intentKey = partIntentKey(order.id, part.id, request.idempotencyKey);
      live = await partLiveCodeTx(tx, context, part.id);
    }
    if (live === null || live.method === "qris") return null;
    // Same choice, still pending: the main transaction returns that code.
    if (
      live.status === "pending" &&
      live.method === request.method &&
      (!namesChannel(request.method) || live.channelCode === request.bankCode)
    )
      return null;
    // A replay: this request's own code exists already.
    const [replay] = await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.idempotencyKey, intentKey),
        ),
      );
    if (replay) return null;
    return { paymentLinkId: order.paymentLinkId, billSplitId: splitId };
  });
  if (scope === null) return;
  // `next` is read again where the candidates are read: a twin request that
  // issued this very choice between the two reads must not be voided.
  await voidLiveCodesForMethodChange(
    context,
    {
      ...scope,
      next: { method: request.method, channelCode: request.bankCode },
    },
    now,
  );
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
 * legend-kt3t1: the amount the next code of this bill would charge, read
 * server-side: the split part's amount, or the whole order's outstanding
 * amount. Never from the guest's body.
 */
async function billAmountIdr(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  orderId: string,
  splitId: string | null,
  now: Date,
): Promise<number> {
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    if (splitId !== null)
      return (await lockSplitPartTx(tx, context, session.id, splitId))
        .amountIdr;
    const order = await lockSessionOrder(tx, context, session.id, orderId);
    if (order.paymentLinkId === null)
      throw new CoreError("CONFLICT", "Tagihan ini belum siap dibayar.");
    const [link] = await tx
      .select()
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.id, order.paymentLinkId),
        ),
      );
    if (!link) throw new CoreError("NOT_FOUND", "Tagihan tidak ditemukan.");
    return outstandingIdr(link);
  });
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
  // The channel of a VA or e-wallet; QRIS and card carry none.
  const bankCode = namesChannel(parsed.method)
    ? (parsed.bankCode ?? null)
    : null;
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
  // legend-nqfov: a retry of an answered request replays the stored answer
  // before any availability check or void: it must not depend on the method
  // being offered right now. A miss falls through to today's flow.
  {
    const { idempotencyKey: peekKey, ...peekRequest } = parsed;
    const replay = await withTenant(db, context, async (tx) => {
      const session = await lockGuestSessionForPayment(
        tx,
        context,
        credential,
        sessionId,
        now,
        "share",
      );
      const stored = await qrOrderPeekIdempotent<GuestPayment>(
        tx,
        context,
        { sessionId: session.id },
        peekKey,
        "payment.create",
        peekRequest,
      );
      return stored === undefined
        ? undefined
        : closePayLinkIfNotPending(tx, context, stored, now);
    });
    if (replay !== undefined) return replay;
  }
  // Checked after the session lock so the outlet's own channel list decides,
  // at the real bill amount and before any old code is voided (legend-kt3t1).
  if (parsed.method === "ewallet" || parsed.method === "card") {
    const amountIdr = await billAmountIdr(
      context,
      credential,
      sessionId,
      orderId,
      splitId,
      now,
    );
    await assertGuestMethodOffered(context, parsed.method, outletId, amountIdr);
    if (bankCode !== null && parsed.method === "ewallet")
      await assertGuestChannel(
        context,
        parsed.method,
        bankCode,
        outletId,
        amountIdr,
      );
  } else if (bankCode !== null && namesChannel(parsed.method))
    await assertGuestChannel(context, parsed.method, bankCode, outletId);
  // legend-9vmit: a changed method or bank voids the old code first.
  await voidOldCodesForChange(
    context,
    credential,
    sessionId,
    orderId,
    splitId,
    {
      method: parsed.method,
      bankCode,
      payerSecret: parsed.payerSecret,
      idempotencyKey: parsed.idempotencyKey,
    },
    now,
  );
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
    const answer = await qrOrderIdempotent(
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
            // legend-9vmit: a payer who switched method or bank had the old
            // VA / bank transfer code voided before this transaction
            // (`voidOldCodesForChange`), so it is no longer live here. Reaching
            // this throw means a QRIS code, a code that could not be voided,
            // or a race: it stays as the safety net.
            // No payer hash yet means no payer: a live code here is an orphan
            // (its creating transaction rolled back), so nobody gets it.
            if (
              part.payerSecretHash !== null &&
              live.status === "pending" &&
              live.method === parsed.method &&
              (!namesChannel(parsed.method) || live.channelCode === bankCode)
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
          // SO-896: money parked anywhere on the bill (a POS tender, another
          // part, the whole-order code) blocks a part code as well.
          if (
            (await failedPartCodeWithOpenFundTx(
              tx,
              context.tenant.tenantId,
              part.id,
            )) ||
            (await failedOrderCodeWithOpenFundTx(
              tx,
              context.tenant.tenantId,
              order,
            ))
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
              idempotencyKey: partIntentKey(order.id, part.id, idempotencyKey),
              expiresAt: tableSessionTokenExpiresAt({
                openedAt: session.openedAt.toISOString(),
                closedAt: session.closedAt?.toISOString() ?? null,
              }),
            },
            { billSplitId: part.id, amountIdr: part.amountIdr },
            now,
            { orderLockedByCaller: true },
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
        // be paid, whatever method the guest now asks for. legend-9vmit: a
        // guest who switches away from a VA / bank transfer code had it voided
        // before this transaction (`voidOldCodesForChange`), so it is not
        // live here; this throw stays as the safety net (QRIS, a race).
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
            idempotencyKey: orderIntentKey(order.id, idempotencyKey),
            // A code never outlives the guest's session credential; WS-05
            // caps it at the method default (VA 180 minutes).
            expiresAt: tableSessionTokenExpiresAt({
              openedAt: session.openedAt.toISOString(),
              closedAt: session.closedAt?.toISOString() ?? null,
            }),
          },
          now,
          { orderLockedByCaller: true },
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
    return closePayLinkIfNotPending(tx, context, answer, now);
  });
}

/**
 * legend-kt3t1: a replayed idempotency key serves the answer stored when the
 * code was created, which still carries the pay link. If the guest switched
 * away from that e-wallet or card since (or it lapsed), the stored answer must
 * not hand the old pay link out again: read the code's real state and show it
 * without the link. A code that is still pending is returned as stored.
 */
async function closePayLinkIfNotPending(
  tx: Tx,
  context: ScopedTenantContext,
  answer: GuestPayment,
  now: Date,
): Promise<GuestPayment> {
  if (answer.redirectUrl === null) return answer;
  const [row] = await tx
    .select({
      status: paymentIntents.status,
      expiresAt: paymentIntents.expiresAt,
      paidAt: paymentIntents.paidAt,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, answer.id),
      ),
    );
  if (!row) return { ...answer, status: "expired", redirectUrl: null };
  if (row.status === "pending" && row.expiresAt > now) return answer;
  return {
    ...answer,
    status: row.status === "pending" ? "expired" : row.status,
    // `paid` and `paidAt` go together (guestPaymentSchema): the stored answer
    // was made before the payment arrived.
    paidAt: row.status === "paid" ? (row.paidAt?.toISOString() ?? null) : null,
    redirectUrl: null,
  };
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
