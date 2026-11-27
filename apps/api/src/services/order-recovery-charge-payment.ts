// Guest payment of a dearer-swap charge (bead legend-i83ls, slice S2; design
// scratchpad design-B.md "QR pay-first" and "Idempoten").
//
// The order of a pay-first QR table is already paid through its own link. The
// price difference of a dearer swap (+ service charge + PBJT) is a separate
// bill: `order_issue_charges` (route `qr_link`) gets its OWN payment link
// (`oic:<chargeId>`), opened lazily the first time the guest pays, and its own
// QRIS/VA intent. The order, its link and its intent are never touched, so a
// payment here can never reach `handleQrOrderPaymentPaid` (`double_payment` /
// `amount_mismatch` on the order's bill).
//
// - `listIssueChargesOfSession`: the session's charges (guest credential).
// - `createIssueChargePayment`: opens the link (token sealed on the charge, like
//   `orders.payment_link_token_sealed`) and one live intent for the charge's
//   amount. Same method and bank returns the pending code; another choice
//   supersedes it (one live code per bill). Lock order: session -> issue ->
//   order -> charge -> link -> intent.
// - `dispatchIssueChargePaid` / `dispatchIssueChargeClosed`: the WS-05 events of
//   the charge's link (called by order-payment-consumers.ts). Money that no
//   charge can take (a second code after the charge was paid, a code paid after
//   the charge was waived or expired) goes back through the same system refund
//   requests as a QR order's late and double payments; the approval stays with
//   WS-05. The charge's order only names the refund in the audit trail.

import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import {
  CoreError,
  uuidSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  createIssueChargePaymentInputSchema,
  sessionBillChargeSchema,
  tableSessionTokenExpiresAt,
  type GuestPayment,
  type SessionBillCharge,
} from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { paymentLinks } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { assertNoEdcSaleOutstanding } from "./order-recovery-charge-money-path.ts";
import {
  handleIssueChargeClosed,
  handleIssueChargePaid,
  lockChargeChain,
  type IssueChargeClosedOutcome,
  type IssueChargePaidOutcome,
} from "./order-recovery-charge.ts";
import {
  cancelPaymentLinkInTx,
  createIntent,
  createPaymentLink,
  getIntentView,
} from "./payment.service.ts";
import {
  assertVaBank,
  chargeLinkSealAad,
  guestPaymentDto,
  sameChoice,
} from "./qr-order-payment.ts";
import {
  requestQrDoublePaymentRefund,
  requestQrLatePaymentRefund,
} from "./qr-order-late-payment.ts";
import { assertNoActiveQrisHold } from "./pos-qris-hold.ts";
import { notifyQrOrderChange } from "./qr-order-realtime-signal.ts";
import {
  loadQrZoneOfSession,
  lockGuestSessionForPayment,
  qrOrderIdempotent,
} from "./qr-order.service.ts";

type CreateIssueChargePaymentInput = z.output<
  typeof createIssueChargePaymentInputSchema
>;
type ChargeRow = typeof orderIssueCharges.$inferSelect;

/** `payment_links.created_by` is free text; QR guests are not users. */
const LINK_CREATED_BY = "system:qr-order";
const paymentPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  paymentLinkId: uuidSchema,
});

/** `payment_links.reference` holds at most 40 characters: `oic:` + a UUID. */
const linkReference = (chargeId: string) => `oic:${chargeId}`;

function chargeDto(charge: ChargeRow): SessionBillCharge {
  return sessionBillChargeSchema.parse({
    id: charge.id,
    orderIssueId: charge.orderIssueId,
    orderId: charge.orderId,
    status: charge.status,
    differenceIdr: Number(charge.differenceIdr),
    grossSalesIdr: Number(charge.grossSalesIdr),
    serviceChargeIdr: Number(charge.serviceChargeIdr),
    pbjtIdr: Number(charge.pbjtIdr),
    amountIdr: Number(charge.amountIdr),
    paidAt: charge.paidAt?.toISOString() ?? null,
  });
}

/**
 * GET /api/table-sessions/:sessionId/issue-charges. The charges of the
 * guest's own session, oldest first.
 */
export async function listIssueChargesOfSession(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now = new Date(),
): Promise<SessionBillCharge[]> {
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const rows = await tx
      .select()
      .from(orderIssueCharges)
      .where(
        and(
          eq(orderIssueCharges.tenantId, context.tenant.tenantId),
          eq(orderIssueCharges.tableSessionId, session.id),
        ),
      )
      .orderBy(asc(orderIssueCharges.createdAt), asc(orderIssueCharges.id));
    return rows.map(chargeDto);
  });
}

/** The session's own QR charge, locked (issue, order, charge); 404 otherwise. */
async function lockSessionCharge(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  chargeId: string,
): Promise<ChargeRow> {
  const locked = await lockChargeChain(tx, context.tenant.tenantId, {
    chargeId,
  });
  if (
    !locked ||
    locked.charge.tableSessionId !== sessionId ||
    locked.charge.route !== "qr_link"
  )
    throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
  return locked.charge;
}

function assertTakesMoney(charge: ChargeRow): void {
  if (charge.status !== "open")
    throw new CoreError("CONFLICT", "Tagihan ini sudah tidak menunggu bayar.");
}

/**
 * Opens the charge's WS-05 bill inside the caller's transaction (which holds
 * the charge row) and points the charge at it. The guest session and the
 * cashier at the till (legend-gt98h, no table) both come through here.
 */
export async function openChargeLinkInTx(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
  table: { tableLabel: string; pax: number } | { tableLabel: null; pax: null },
  now: Date,
): Promise<{ linkId: string; token: string }> {
  // `createPaymentLink` commits on its own: a crash before the charge got
  // its `payment_link_id` leaves an orphan `oic:<chargeId>` link. Its token
  // was never handed out, so no intent can exist on it and it cannot be
  // reused (only the sealed token on the charge could be). Cancel it so one
  // active link per charge remains.
  const orphans = await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, context.tenant.tenantId),
        eq(paymentLinks.reference, linkReference(charge.id)),
        or(isNull(paymentLinks.expiresAt), gt(paymentLinks.expiresAt, now)),
      ),
    )
    .orderBy(asc(paymentLinks.id));
  for (const orphan of orphans)
    await cancelPaymentLinkInTx(tx, context, {
      linkId: orphan.id,
      now,
      reason: "issue_charge_orphan_link",
    });
  const opened = await createPaymentLink(
    context,
    {
      outletId: charge.outletId,
      reference: linkReference(charge.id),
      ...table,
      // Same total as the charge: gross + service + PBJT, no discount.
      subtotalIdr: Number(charge.grossSalesIdr),
      discountIdr: 0,
      serviceChargeIdr: Number(charge.serviceChargeIdr),
      taxIdr: Number(charge.pbjtIdr),
      roundingIdr: 0,
      totalIdr: Number(charge.amountIdr),
      returnPath: null,
    },
    LINK_CREATED_BY,
    now,
  );
  await tx
    .update(orderIssueCharges)
    .set({
      paymentLinkId: opened.linkId,
      paymentLinkTokenSealed: sealSecret(
        opened.token,
        chargeLinkSealAad(context.tenant.tenantId, charge.id),
      ),
      updatedAt: now,
    })
    .where(
      and(
        eq(orderIssueCharges.tenantId, context.tenant.tenantId),
        eq(orderIssueCharges.id, charge.id),
      ),
    );
  return { linkId: opened.linkId, token: opened.token };
}

/**
 * Step 1: the charge's WS-05 bill, opened once. The link is created through
 * `createPaymentLink` (its own transaction) while this transaction holds the
 * charge row, so concurrent payers never open two bills for one charge.
 * Returns the session's outlet (the gateway picks that outlet's account).
 */
async function ensureChargeLink(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  chargeId: string,
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
    const charge = await lockSessionCharge(tx, context, session.id, chargeId);
    if (charge.status === "paid" || charge.paymentLinkId !== null)
      return session.outletId;
    assertTakesMoney(charge);
    const { tableCode } = await loadQrZoneOfSession(tx, context, session);
    await openChargeLinkInTx(
      tx,
      context,
      charge,
      { tableLabel: tableCode, pax: session.pax },
      now,
    );
    return session.outletId;
  });
}

/**
 * POST /api/table-sessions/:sessionId/issue-charges/:chargeId/payments. One
 * live QRIS or VA code for the charge's amount (PAY-01: the amount is the
 * server's). A replay with the same idempotency key answers the first result.
 */
export async function createIssueChargePayment(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  chargeId: string,
  input: CreateIssueChargePaymentInput,
  now = new Date(),
): Promise<GuestPayment> {
  const parsed = createIssueChargePaymentInputSchema.parse(input);
  const bankCode = parsed.method === "va" ? (parsed.bankCode ?? null) : null;
  const target = { kind: "issue_charge", chargeId } as const;
  const outletId = await ensureChargeLink(
    context,
    credential,
    sessionId,
    chargeId,
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
      "issue_charge_payment.create",
      { chargeId, ...request },
      async () => {
        const charge = await lockSessionCharge(
          tx,
          context,
          session.id,
          chargeId,
        );
        if (charge.paymentLinkTokenSealed === null)
          throw new Error("Charge payment link token missing");
        const token = openSecret(
          charge.paymentLinkTokenSealed,
          chargeLinkSealAad(context.tenant.tenantId, charge.id),
        );
        if (charge.status === "paid" && charge.paymentIntentId !== null)
          return guestPaymentDto(
            await getIntentView(context, token, charge.paymentIntentId, now),
            target,
          );
        assertTakesMoney(charge);
        // One live code per charge: the same method and bank returns the
        // pending intent; another choice opens a new one, which supersedes it.
        if (charge.paymentIntentId !== null) {
          const current = await getIntentView(
            context,
            token,
            charge.paymentIntentId,
            now,
          );
          if (
            current.status === "paid" ||
            (current.status === "pending" &&
              sameChoice(current, parsed.method, bankCode))
          )
            return guestPaymentDto(current, target);
        }
        // legend-f1mmf (review K): a card sale of the charge that is
        // unresolved or approved may hold the money already; no new code.
        await assertNoEdcSaleOutstanding(tx, context.tenant.tenantId, charge);
        // legend-ek1wt: a charge code is a code issuer too; while a QR of the
        // order's bill can still be paid, no new code (409 QRIS_HOLD_ACTIVE).
        await assertNoActiveQrisHold(tx, context, charge.orderId);
        const intent = await createIntent(
          context,
          token,
          {
            method: parsed.method,
            channelCode: bankCode,
            ...(parsed.expectedChargedIdr === undefined
              ? {}
              : { expectedChargedIdr: parsed.expectedChargedIdr }),
            // The WS-05 key is unique per tenant; derive it from the charge so
            // a guest key can never collide with another session's payment.
            idempotencyKey: `qic-${createHash("sha256")
              .update(`${charge.id}:${idempotencyKey}`)
              .digest("hex")
              .slice(0, 48)}`,
            // A code never outlives the guest's session credential.
            expiresAt: tableSessionTokenExpiresAt({
              openedAt: session.openedAt.toISOString(),
              closedAt: session.closedAt?.toISOString() ?? null,
            }),
          },
          now,
          { orderLockedByCaller: true, requireExpectedCharged: true },
        );
        await tx
          .update(orderIssueCharges)
          .set({ paymentIntentId: intent.id, updatedAt: now })
          .where(
            and(
              eq(orderIssueCharges.tenantId, context.tenant.tenantId),
              eq(orderIssueCharges.id, charge.id),
            ),
          );
        return guestPaymentDto(intent, target);
      },
    );
  });
}

// ---- WS-05 events of the charge link ----------------------------------------

async function chargeOfLink(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string,
): Promise<ChargeRow | null> {
  const [charge] = await tx
    .select()
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, context.tenant.tenantId),
        eq(orderIssueCharges.paymentLinkId, paymentLinkId),
      ),
    );
  return charge ?? null;
}

/**
 * `payment.paid` of a swap-difference link. Null when the link is not a
 * charge's (the dispatcher goes on to the POS consumer). Money a charge cannot
 * take is returned through the system refund requests; the order's tables are
 * not touched.
 */
export async function dispatchIssueChargePaid(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now: Date,
): Promise<IssueChargePaidOutcome | null> {
  const outcome = await handleIssueChargePaid(context, event, tx, now);
  if (outcome === "ignored") return null;
  if (outcome === "paid") {
    const payload = paymentPayloadSchema.parse(event.payload);
    const charge = await chargeOfLink(tx, context, payload.paymentLinkId);
    // The guest's phone shows the charge as paid.
    if (charge?.tableSessionId)
      await notifyQrOrderChange(tx, context, {
        sessionId: charge.tableSessionId,
        orderId: charge.orderId,
        status: "sent",
      });
    return outcome;
  }
  if (
    outcome !== "double_payment" &&
    outcome !== "late_payment_on_closed_charge"
  )
    return outcome;
  const payload = paymentPayloadSchema.parse(event.payload);
  const charge = await chargeOfLink(tx, context, payload.paymentLinkId);
  if (!charge) return outcome;
  const refund = {
    order: { id: charge.orderId, outletId: charge.outletId },
    paymentLinkId: payload.paymentLinkId,
    intentId: payload.intentId,
    now,
  };
  // A charge that was waived or expired never takes the money: the whole
  // intent goes back. A second code after the charge was paid was booked as
  // `double_payment` unallocated funds.
  if (outcome === "late_payment_on_closed_charge")
    await requestQrLatePaymentRefund(tx, context, refund);
  await requestQrDoublePaymentRefund(tx, context, refund);
  return outcome;
}

/** `payment.expired` / `payment.failed` of a swap-difference link; null if not one. */
export async function dispatchIssueChargeClosed(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now: Date,
): Promise<IssueChargeClosedOutcome | null> {
  const outcome = await handleIssueChargeClosed(context, event, tx, now);
  return outcome === "ignored" ? null : outcome;
}
