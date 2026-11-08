// Payment links and intent lifecycle (bead legend-gz3; PRD v1.7 §3.13
// "Orkestrasi Pembayaran", §6 D `payment_intents` / `unallocated_funds`).
//
// PAY-01: the amount always comes from this service (the link's outstanding
// balance), never from the request. The idempotency key is unique per tenant.
// PAY-02: an intent becomes paid only through `confirmPayment`, whose caller
// must present verified evidence; the gateway status check is the same path.
// PAY-04: a second payment or an overpayment is recorded as unallocated funds
// (`payment-unallocated.service.ts`), never absorbed into the bill.
// PAY-05: routing only decides which provider receives a new intent; nothing
// here rewrites an order, a journal or a report.
//
// Provider calls happen outside the tenant transaction (as with object
// storage): read a plan, call the gateway, then write in one transaction. The
// gateway adapter is idempotent per key, so a retry cannot create two codes.

import { randomUUID } from "node:crypto";
import {
  assertOutletInScope,
  createUlid,
  idr,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  customerPaymentIntentSchema,
  createPaymentIntentInputSchema,
  paymentLinkTokenSchema,
  paymentLinkViewSchema,
  paymentMethodSchema,
  payAtCashierAcknowledgementSchema,
  type CreatePaymentIntentInput,
  type CustomerPaymentIntent,
  type PaymentChannel,
  type PaymentInstructions,
  type PaymentIntent,
  type PaymentLinkView,
  type PayAtCashierAcknowledgement,
} from "@starter/shared/payment";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  outlets,
  paymentEvidence,
  paymentIntents,
  paymentLinks,
  paymentLinkTokens,
  paymentUnallocatedFunds,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import {
  decidePaymentConfirmation,
  type PaymentConfirmation,
} from "./payment-lifecycle";
import {
  paymentGateway,
  type GatewayIntent,
  type OnlinePaymentMethod,
} from "./payment-gateway";
import {
  onlinePaymentMethodSchema,
  resolveRoutingRule,
} from "./payment-routing.service";
import {
  appendPaymentEvent,
  createPaymentLinkToken,
  hashPaymentLinkToken,
  outstandingIdr,
  toCustomerIntent,
  toPaymentIntent,
  uniqueViolation,
  type PaymentIntentRow,
  type PaymentLinkRow,
} from "./payment-support";
import type { Tx } from "./permission-resolver";

/** PRD §3.13 "QRIS Dinamis": a QR code lives about 10 minutes. VA and bank
 * transfer instructions stay payable for 3 hours (PRD silent; the gateway may
 * shorten either value). */
const INTENT_LIFETIME_MINUTES: Record<OnlinePaymentMethod, number> = {
  qris: 10,
  va: 180,
  bank_transfer: 180,
};
/** A bill link is short-lived: 24 hours unless the caller sets its own. */
const LINK_LIFETIME_MINUTES = 24 * 60;
const SETTLED_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

const nonnegativeIdr = idrSchema.refine((n) => n >= 0);

/** What another server service supplies when it opens a bill for payment. */
export const createPaymentLinkInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    reference: z.string().min(1).max(40),
    tableLabel: z.string().min(1).max(40).nullable(),
    pax: z.number().int().min(1).max(30).nullable(),
    subtotalIdr: nonnegativeIdr,
    discountIdr: nonnegativeIdr,
    serviceChargeIdr: nonnegativeIdr,
    taxIdr: nonnegativeIdr,
    /** May be negative (a rounding discount); the total formula is checked. */
    roundingIdr: idrSchema,
    totalIdr: nonnegativeIdr,
    returnPath: z
      .string()
      .max(300)
      .regex(/^\/(?!\/)/, "Return paths are app-local")
      .nullable(),
    expiresInMinutes: z.number().int().min(1).max(10080).optional(),
  })
  .superRefine((bill, ctx) => {
    if (
      bill.totalIdr !==
      bill.subtotalIdr -
        bill.discountIdr +
        bill.serviceChargeIdr +
        bill.taxIdr +
        bill.roundingIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message:
          "Total must equal subtotal − discount + service + tax + rounding",
      });
    if ((bill.tableLabel === null) !== (bill.pax === null))
      ctx.addIssue({
        code: "custom",
        path: ["pax"],
        message: "A table bill carries the table label and pax together",
      });
  });
/** Accepted input (pre-brand numbers); the schema parses it to whole rupiah. */
export type CreatePaymentLinkInput = z.input<
  typeof createPaymentLinkInputSchema
>;

export type OpenedPaymentLink = {
  /** Handed to the guest once; only its SHA-256 hash is stored. */
  readonly token: string;
  readonly linkId: string;
  readonly expiresAt: string;
};

/** Evidence a verified caller presents to `confirmPayment` (PAY-02). */
export const paymentConfirmationSchema = z.strictObject({
  source: z.enum([
    "verified_webhook",
    "gateway_status",
    "edc_ecr",
    "authorized_cash",
    "authorized_edc_standalone",
  ]),
  method: paymentMethodSchema,
  amountIdr: idrSchema.refine((n) => n > 0),
  providerRef: z.string().min(1).max(100),
  at: isoDateTimeSchema,
});
export type PaymentConfirmationInput = z.input<
  typeof paymentConfirmationSchema
>;

export type PaymentActor =
  { readonly type: "user"; readonly id: string } | { readonly type: "system" };

// ---------------------------------------------------------------- links

/**
 * Opens a bill for payment and returns the guest token once. Called by the
 * service that owns the bill (QR checkout, POS, reservation deposit, recurring
 * invoice) inside its own flow.
 */
export async function createPaymentLink(
  context: ScopedTenantContext,
  input: CreatePaymentLinkInput,
  actorUserId: string,
  now = new Date(),
): Promise<OpenedPaymentLink> {
  const parsed = createPaymentLinkInputSchema.parse(input);
  assertOutletInScope(context.outletScope, parsed.outletId);
  const token = createPaymentLinkToken();
  const tokenHash = hashPaymentLinkToken(token);
  const expiresAt = new Date(
    now.getTime() + (parsed.expiresInMinutes ?? LINK_LIFETIME_MINUTES) * 60_000,
  );
  const linkId = await withTenant(db, context, async (tx) => {
    const [link] = await tx
      .insert(paymentLinks)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: parsed.outletId,
        tokenHash,
        reference: parsed.reference,
        tableLabel: parsed.tableLabel,
        pax: parsed.pax,
        subtotalIdr: parsed.subtotalIdr,
        discountIdr: parsed.discountIdr,
        serviceChargeIdr: parsed.serviceChargeIdr,
        taxIdr: parsed.taxIdr,
        roundingIdr: parsed.roundingIdr,
        totalIdr: parsed.totalIdr,
        returnPath: parsed.returnPath,
        expiresAt,
        createdBy: actorUserId,
        updatedAt: now,
      })
      .returning();
    if (!link) throw new Error("Payment link insert returned no row");
    await tx.insert(paymentLinkTokens).values({
      tokenHash,
      tenantId: context.tenant.tenantId,
      outletId: parsed.outletId,
      paymentLinkId: link.id,
      expiresAt,
    });
    return link.id;
  });
  return { token, linkId, expiresAt: expiresAt.toISOString() };
}

/** Hash -> tenant/outlet/link, resolved before a tenant context exists. */
export async function resolvePaymentLinkToken(token: string) {
  const parsed = paymentLinkTokenSchema.safeParse(token);
  if (!parsed.success) return null;
  const [row] = await db
    .select()
    .from(paymentLinkTokens)
    .where(
      and(
        eq(paymentLinkTokens.tokenHash, hashPaymentLinkToken(parsed.data)),
        gt(paymentLinkTokens.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

async function loadLink(
  context: ScopedTenantContext,
  token: string,
  now: Date,
): Promise<PaymentLinkRow> {
  const parsedToken = paymentLinkTokenSchema.parse(token);
  const tokenHash = hashPaymentLinkToken(parsedToken);
  const link = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.tokenHash, tokenHash),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!link || (link.expiresAt !== null && link.expiresAt <= now))
    throw new HttpError(
      404,
      "NOT_FOUND",
      "This payment link is not available.",
    );
  assertOutletInScope(context.outletScope, link.outletId);
  return link;
}

// ------------------------------------------------------------- link view

type RoutedMethod = {
  readonly method: OnlinePaymentMethod;
  readonly provider: string;
  readonly enabled: boolean;
  readonly unavailableReason: "gateway_down" | "routing_disabled" | null;
  readonly channels: PaymentChannel[];
};

/** Routing rules for the three online methods, read in one transaction. */
async function routeOnlineMethods(
  context: ScopedTenantContext,
  link: PaymentLinkRow,
): Promise<
  Array<{ method: OnlinePaymentMethod; provider: string; enabled: boolean }>
> {
  return withTenant(db, context, async (tx) => {
    const routed = [];
    for (const method of ["qris", "va", "bank_transfer"] as const) {
      const routing = await resolveRoutingRule(
        tx,
        context,
        link.outletId,
        method,
      );
      routed.push({
        method,
        provider: routing.provider,
        enabled: routing.enabled,
      });
    }
    return routed;
  });
}

async function onlineMethods(
  context: ScopedTenantContext,
  link: PaymentLinkRow,
): Promise<RoutedMethod[]> {
  const gateway = paymentGateway();
  const [routed, health] = await Promise.all([
    routeOnlineMethods(context, link),
    gateway.health(context),
  ]);
  const gatewayUsable = health.status !== "down";
  const result: RoutedMethod[] = [];
  for (const entry of routed) {
    const channels =
      entry.method === "qris"
        ? []
        : await gateway.channels(context, entry.method);
    const configured = entry.method === "qris" || channels.length > 0;
    const enabled = entry.enabled && gatewayUsable && configured;
    const unavailableReason = !entry.enabled
      ? ("routing_disabled" as const)
      : enabled
        ? null
        : gatewayUsable
          ? // Routing is on but no bank/channel is configured for the method.
            ("routing_disabled" as const)
          : ("gateway_down" as const);
    result.push({ ...entry, enabled, unavailableReason, channels });
  }
  return result;
}

/** Everything the guest payment screen needs on first render. */
export async function getPaymentLinkView(
  context: ScopedTenantContext,
  token: string,
  now = new Date(),
): Promise<PaymentLinkView> {
  const parsedToken = paymentLinkTokenSchema.parse(token);
  const link = await loadLink(context, parsedToken, now);
  const [health, methods] = await Promise.all([
    paymentGateway().health(context),
    onlineMethods(context, link),
  ]);
  const { activeIntent, timeZone } = await withTenant(
    db,
    context,
    async (tx) => {
      const rows = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.paymentLinkId, link.id),
          ),
        )
        .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id));
      const payable = rows.find(
        (row) => row.status === "pending" && row.expiresAt > now,
      );
      const settled = rows.find((row) =>
        (SETTLED_STATUSES as readonly string[]).includes(row.status),
      );
      const [outlet] = await tx
        .select({ timeZone: outlets.timezone })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, context.tenant.tenantId),
            eq(outlets.id, link.outletId),
          ),
        );
      return {
        activeIntent: payable ?? settled ?? null,
        timeZone: outlet?.timeZone ?? "Asia/Jakarta",
      };
    },
  );
  return paymentLinkViewSchema.parse({
    token: parsedToken,
    bill: {
      reference: link.reference,
      tableLabel: link.tableLabel,
      pax: link.pax,
      totals: {
        subtotalIdr: link.subtotalIdr,
        discountIdr: link.discountIdr,
        serviceChargeIdr: link.serviceChargeIdr,
        taxIdr: link.taxIdr,
        roundingIdr: link.roundingIdr,
        totalIdr: link.totalIdr,
        paidIdr: link.paidIdr,
        outstandingIdr: outstandingIdr(link),
      },
    },
    methods: methods.map((entry) => ({
      method: entry.method,
      enabled: entry.enabled,
      unavailableReason: entry.unavailableReason,
      channels: entry.channels,
    })),
    gateway: { status: health.status },
    activeIntent: activeIntent ? toCustomerIntent(activeIntent) : null,
    returnPath: link.returnPath,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    serverTime: now.toISOString(),
    timeZone,
  });
}

// ---------------------------------------------------------------- intents

type IntentPlan = {
  readonly link: PaymentLinkRow;
  readonly provider: string;
  readonly existing: PaymentIntentRow | null;
};

/**
 * PAY-01: an idempotency key is bound to the request fingerprint (link +
 * method + channel). The same key with a different payload is a client bug,
 * never a retry, so it always fails IDEMPOTENCY_KEY_REUSED — including on the
 * unique-key race path, where the first request may still be committing.
 */
function assertIdempotencyFingerprint(
  existing: PaymentIntentRow,
  request: {
    readonly paymentLinkId: string;
    readonly method: CreatePaymentIntentInput["method"];
    readonly channelCode: string | null;
  },
): void {
  if (
    existing.paymentLinkId !== request.paymentLinkId ||
    existing.method !== request.method ||
    existing.channelCode !== request.channelCode
  )
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for another payment.",
    );
}

async function readIntentPlan(
  context: ScopedTenantContext,
  token: string,
  input: CreatePaymentIntentInput,
  now: Date,
): Promise<IntentPlan> {
  const link = await loadLink(context, token, now);
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      assertIdempotencyFingerprint(existing, {
        paymentLinkId: link.id,
        method: input.method,
        channelCode: input.channelCode,
      });
      return { link, provider: existing.provider, existing };
    }
    if (outstandingIdr(link) <= 0)
      throw new HttpError(409, "CONFLICT", "This bill is already paid.");
    const routing = await resolveRoutingRule(
      tx,
      context,
      link.outletId,
      input.method,
    );
    if (!routing.enabled)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "This payment method is not available.",
      );
    return { link, provider: routing.provider, existing: null };
  });
}

async function supersedePending(
  tx: Tx,
  context: ScopedTenantContext,
  link: PaymentLinkRow,
  now: Date,
): Promise<void> {
  const pending = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.paymentLinkId, link.id),
        eq(paymentIntents.status, "pending"),
      ),
    );
  for (const row of pending) {
    const updated = await tx
      .update(paymentIntents)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, row.id),
          eq(paymentIntents.status, "pending"),
        ),
      )
      .returning();
    if (updated.length === 0) continue;
    await appendPaymentEvent(tx, context, {
      name: "payment.expired",
      aggregateId: row.id,
      outletId: link.outletId,
      actor: { type: "system" },
      payload: { intentId: row.id, reason: "superseded" },
      now,
    });
  }
}

/**
 * Creates one payable intent. The amount is the link's outstanding balance
 * (PAY-01); any previous pending code is superseded, so one bill never shows
 * two live codes.
 */
export async function createIntent(
  context: ScopedTenantContext,
  token: string,
  input: CreatePaymentIntentInput,
  now = new Date(),
): Promise<CustomerPaymentIntent> {
  const parsed = createPaymentIntentInputSchema.parse(input);
  const plan = await readIntentPlan(context, token, parsed, now);
  if (plan.existing) return toCustomerIntent(plan.existing);
  const amountIdr = outstandingIdr(plan.link);
  if (amountIdr <= 0)
    throw new HttpError(409, "CONFLICT", "This bill is already paid.");

  const gateway = paymentGateway();
  const health = await gateway.health(context);
  if (health.status === "down")
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "The payment gateway is unavailable; pay at the cashier.",
    );

  const requestedExpiry = new Date(
    now.getTime() + INTENT_LIFETIME_MINUTES[parsed.method] * 60_000,
  );
  const intentId = randomUUID();
  const created: GatewayIntent = await gateway.createIntent({
    context,
    provider: plan.provider,
    intentId,
    method: parsed.method,
    channelCode: parsed.channelCode,
    amountIdr,
    idempotencyKey: parsed.idempotencyKey,
    expiresAt: requestedExpiry.toISOString(),
  });
  const expiresAt = new Date(
    Math.min(Date.parse(created.expiresAt), requestedExpiry.getTime()),
  );
  const instructions: PaymentInstructions = created.instructions;

  try {
    return await withTenant(db, context, async (tx) => {
      // Re-check inside the transaction: a concurrent retry may have won.
      const [existing] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.idempotencyKey, parsed.idempotencyKey),
          ),
        );
      if (existing) {
        assertIdempotencyFingerprint(existing, {
          paymentLinkId: plan.link.id,
          method: parsed.method,
          channelCode: parsed.channelCode,
        });
        return toCustomerIntent(existing);
      }
      // One live code per bill: lock the bill row (same order as settlement:
      // bill, then intents) so two creates with different keys serialize and
      // the second supersedes the first. The balance is re-read under the lock;
      // if a settlement landed since the plan, the code just minted at the old
      // amount is never stored (PAY-01: the amount is the current outstanding).
      const [lockedLink] = await tx
        .select()
        .from(paymentLinks)
        .where(
          and(
            eq(paymentLinks.tenantId, context.tenant.tenantId),
            eq(paymentLinks.id, plan.link.id),
          ),
        )
        .for("update");
      // legend-b0au: the gateway call above ran outside any lock, so a
      // `cancelPaymentLinkInTx` (cash replaced the QRIS, order voided) may have
      // committed meanwhile. A link that is closed now, or whose expiry moved
      // since the plan (the cancel stamps its own `now`, which can be later
      // than this request's clock), never receives the new intent.
      if (
        !lockedLink ||
        (lockedLink.expiresAt !== null &&
          (lockedLink.expiresAt <= now ||
            lockedLink.expiresAt.getTime() !== plan.link.expiresAt?.getTime()))
      )
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This payment link is not available.",
        );
      if (outstandingIdr(lockedLink) !== amountIdr)
        throw new HttpError(
          409,
          "CONFLICT",
          "This bill changed while the payment was prepared. Reload and try again.",
        );
      await supersedePending(tx, context, plan.link, now);
      const [row] = await tx
        .insert(paymentIntents)
        .values({
          id: intentId,
          tenantId: context.tenant.tenantId,
          outletId: plan.link.outletId,
          paymentLinkId: plan.link.id,
          method: parsed.method,
          provider: plan.provider,
          amountIdr,
          idempotencyKey: parsed.idempotencyKey,
          providerRef: created.providerRef,
          status: "pending",
          instructions,
          channelCode: parsed.channelCode,
          expiresAt,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Payment intent insert returned no row");
      await appendPaymentEvent(tx, context, {
        name: "payment_intent.created",
        aggregateId: row.id,
        outletId: row.outletId,
        actor: { type: "system" },
        payload: {
          intentId: row.id,
          paymentLinkId: plan.link.id,
          method: row.method,
          provider: row.provider,
          amountIdr: row.amountIdr,
          expiresAt: expiresAt.toISOString(),
        },
        now,
      });
      return toCustomerIntent(row);
    });
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    // The unique (tenant, idempotency_key) key decided the race.
    const existing = await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.idempotencyKey, parsed.idempotencyKey),
          ),
        );
      return row ?? null;
    });
    if (!existing) throw error;
    // The winner may have been a different request that reused the key.
    assertIdempotencyFingerprint(existing, {
      paymentLinkId: plan.link.id,
      method: parsed.method,
      channelCode: parsed.channelCode,
    });
    return toCustomerIntent(existing);
  }
}

async function loadIntent(
  context: ScopedTenantContext,
  token: string,
  intentId: string,
  now: Date,
): Promise<{ link: PaymentLinkRow; intent: PaymentIntentRow }> {
  const link = await loadLink(context, token, now);
  const id = uuidSchema.parse(intentId);
  const intent = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, id),
          eq(paymentIntents.paymentLinkId, link.id),
        ),
      );
    return row ?? null;
  });
  if (!intent) throw new HttpError(404, "NOT_FOUND", "Payment not found.");
  assertOutletInScope(context.outletScope, intent.outletId);
  return { link, intent };
}

async function expireIntent(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
  reason: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const updated = await tx
      .update(paymentIntents)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
          eq(paymentIntents.status, "pending"),
        ),
      )
      .returning();
    if (updated.length === 0) return;
    await appendPaymentEvent(tx, context, {
      name: "payment.expired",
      aggregateId: intent.id,
      outletId: intent.outletId,
      actor: { type: "system" },
      payload: { intentId: intent.id, reason },
      now,
    });
  });
}

/**
 * Closes a payment link inside the caller's transaction (bead legend-b0au,
 * WS-05): a POS bill whose tender was voided or replaced must stop taking
 * money. The link's `expires_at` moves to `now` (links already expiring sooner
 * keep their date; the link page and `createIntent` refuse an expired link)
 * and every `pending` intent of the link becomes `expired` with its own
 * `payment.expired` event, same shape as `expireIntent`. Idempotent: a second
 * call finds nothing pending and changes nothing. There is no gateway call (the
 * port has no cancel): a customer who still pays the old code is handled as a
 * late payment by the order consumer.
 */
export async function cancelPaymentLinkInTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: { linkId: string; now: Date; reason: string },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await tx
    .update(paymentLinks)
    .set({ expiresAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, input.linkId),
        or(
          isNull(paymentLinks.expiresAt),
          gt(paymentLinks.expiresAt, input.now),
        ),
      ),
    );
  const expired = await tx
    .update(paymentIntents)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, input.linkId),
        eq(paymentIntents.status, "pending"),
      ),
    )
    .returning();
  for (const intent of expired)
    await appendPaymentEvent(tx, context, {
      name: "payment.expired",
      aggregateId: intent.id,
      outletId: intent.outletId,
      actor: { type: "system" },
      payload: { intentId: intent.id, reason: input.reason },
      now: input.now,
    });
}

async function failIntent(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const updated = await tx
      .update(paymentIntents)
      .set({ status: "failed", updatedAt: now })
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
          eq(paymentIntents.status, "pending"),
        ),
      )
      .returning();
    if (updated.length === 0) return;
    await appendPaymentEvent(tx, context, {
      name: "payment.failed",
      aggregateId: intent.id,
      outletId: intent.outletId,
      actor: { type: "system" },
      payload: { intentId: intent.id },
      now,
    });
  });
}

/** Applies a provider status without inventing one (PAY-02). */
async function syncPendingIntent(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
): Promise<PaymentIntentRow> {
  if (intent.status !== "pending") return intent;
  if (intent.expiresAt <= now) {
    await expireIntent(context, intent, now, "timeout");
    return { ...intent, status: "expired", updatedAt: now };
  }
  if (intent.providerRef === null) return intent;
  let providerStatus;
  try {
    providerStatus = await paymentGateway().getStatus({
      context,
      providerRef: intent.providerRef,
    });
  } catch {
    // Gateway outage: the stored status stays; the link view reports it down.
    return intent;
  }
  if (providerStatus.status === "paid") {
    // Fail closed: a status answer without the settled amount proves nothing
    // about how much arrived; the verified webhook settles it instead (PAY-02).
    if (providerStatus.amountIdr === null) return intent;
    return applyConfirmation(
      context,
      intent,
      {
        source: "gateway_status",
        method: intent.method,
        amountIdr: providerStatus.amountIdr,
        providerRef: providerStatus.providerRef,
        at: now.toISOString(),
      },
      { type: "system" },
      now,
    );
  }
  if (providerStatus.status === "expired") {
    await expireIntent(context, intent, now, "gateway");
    return { ...intent, status: "expired", updatedAt: now };
  }
  if (providerStatus.status === "failed") {
    await failIntent(context, intent, now);
    return { ...intent, status: "failed", updatedAt: now };
  }
  return intent;
}

export async function getIntentView(
  context: ScopedTenantContext,
  token: string,
  intentId: string,
  now = new Date(),
): Promise<CustomerPaymentIntent> {
  const parsedToken = paymentLinkTokenSchema.parse(token);
  const { intent } = await loadIntent(context, parsedToken, intentId, now);
  const current = await syncPendingIntent(context, intent, now);
  return customerPaymentIntentSchema.parse(toCustomerIntent(current));
}

/**
 * Replaces an unusable code with a fresh one, so the guest never reloads the
 * page (PRD "QRIS Dinamis"). A pending code is simply returned.
 */
export async function refreshIntent(
  context: ScopedTenantContext,
  token: string,
  intentId: string,
  now = new Date(),
): Promise<CustomerPaymentIntent> {
  const parsedToken = paymentLinkTokenSchema.parse(token);
  const { link, intent } = await loadIntent(
    context,
    parsedToken,
    intentId,
    now,
  );
  const current = await syncPendingIntent(context, intent, now);
  if (current.status === "pending") return toCustomerIntent(current);
  if ((SETTLED_STATUSES as readonly string[]).includes(current.status))
    throw new HttpError(409, "CONFLICT", "This bill is already paid.");
  const method = onlinePaymentMethodSchema.parse(current.method);
  const count = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.paymentLinkId, link.id),
        ),
      );
    return Number(row?.count ?? 0);
  });
  const idempotencyKey = `refresh:${link.id}:${count}`.slice(0, 100);
  return createIntent(
    context,
    parsedToken,
    createPaymentIntentInputSchema.parse({
      method,
      channelCode: current.channelCode,
      idempotencyKey,
    }),
    now,
  );
}

// ---------------------------------------------------------- confirmation

/**
 * PAY-02/PAY-04: applies one verified confirmation. The caller must already
 * have verified the evidence (webhook signature, EDC ECR result, authorized
 * cash officer); this function decides what that evidence may change.
 */
export async function confirmPayment(
  context: ScopedTenantContext,
  intentId: string,
  confirmation: PaymentConfirmationInput,
  actor: PaymentActor = { type: "system" },
  now = new Date(),
): Promise<PaymentIntent> {
  const parsed = paymentConfirmationSchema.parse(confirmation);
  const id = uuidSchema.parse(intentId);
  const intent = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, id),
        ),
      );
    return row ?? null;
  });
  if (!intent) throw new HttpError(404, "NOT_FOUND", "Payment not found.");
  assertOutletInScope(context.outletScope, intent.outletId);
  const updated = await applyConfirmation(
    context,
    intent,
    {
      source: parsed.source,
      method: parsed.method,
      amountIdr: parsed.amountIdr,
      providerRef: parsed.providerRef,
      at: parsed.at,
    },
    actor,
    now,
  );
  return toPaymentIntent(updated);
}

function auditActorOf(actor: PaymentActor) {
  return actor.type === "user"
    ? ({ actorType: "user", actorId: actor.id } as const)
    : ({ actorType: "system", actorId: null } as const);
}

/**
 * Persists the provider transaction identity behind one confirmation (PAY-02,
 * PAY-04). Returns `true` when this is new evidence, `false` when the same
 * provider reference was already applied to this intent (a webhook replay or a
 * retried status check), so the caller records no second money row. Evidence
 * that already belongs to another intent fails closed.
 */
async function recordPaymentEvidence(
  tx: Tx,
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  confirmation: PaymentConfirmation,
): Promise<{ recorded: boolean; evidenceId: string }> {
  const [inserted] = await tx
    .insert(paymentEvidence)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: intent.outletId,
      paymentIntentId: intent.id,
      provider: intent.provider,
      providerRef: confirmation.providerRef,
      method: confirmation.method,
      source: confirmation.source,
      amountIdr: idr(confirmation.amountIdr),
      receivedAt: new Date(confirmation.at),
    })
    .onConflictDoNothing({
      target: [
        paymentEvidence.tenantId,
        paymentEvidence.provider,
        paymentEvidence.providerRef,
      ],
    })
    .returning();
  if (inserted) return { recorded: true, evidenceId: inserted.id };
  const [existing] = await tx
    .select()
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, context.tenant.tenantId),
        eq(paymentEvidence.provider, intent.provider),
        eq(paymentEvidence.providerRef, confirmation.providerRef),
      ),
    );
  if (!existing)
    throw new Error("Payment evidence conflicted without a winner");
  if (existing.paymentIntentId !== intent.id)
    throw new HttpError(
      409,
      "CONFLICT",
      "This payment reference is already recorded for another payment.",
    );
  return { recorded: false, evidenceId: existing.id };
}

/** Re-reads the intent under a row lock, so a replayed evidence path returns
 * the state the first (winning) delivery committed. */
async function lockedIntent(
  tx: Tx,
  context: ScopedTenantContext,
  intentId: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
      ),
    )
    .for("update");
  return row ?? null;
}

async function applyConfirmation(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  confirmation: PaymentConfirmation,
  actor: PaymentActor,
  now: Date,
): Promise<PaymentIntentRow> {
  const auditActor = auditActorOf(actor);
  return withTenant(db, context, async (tx) => {
    // PAY-04 concurrency: lock the bill row (FOR UPDATE) before reading its
    // balance, then the intent row. Every settlement writer takes the locks in
    // this order (bill, then intent), so two settlements for different intents
    // serialize on the bill and two for the same intent serialize on both; the
    // decision below is always made from the committed, locked state — never
    // from a snapshot read before another delivery settled the intent.
    const [freshLink] = await tx
      .select()
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.id, intent.paymentLinkId),
        ),
      )
      .for("update");
    if (!freshLink)
      throw new HttpError(404, "NOT_FOUND", "Payment link not found.");
    const current = await lockedIntent(tx, context, intent.id);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Payment not found.");
    const decision = decidePaymentConfirmation(
      {
        status: current.status,
        method: current.method,
        amountIdr: current.amountIdr,
        providerRef: current.providerRef,
        expiresAt: current.expiresAt.toISOString(),
        flags: current.flags,
      },
      confirmation,
    );
    if (decision.kind === "duplicate") return current;
    if (decision.kind === "reject")
      throw new HttpError(409, "CONFLICT", decision.message);

    if (decision.kind === "double_payment") {
      // PAY-04 retries: one provider transaction must produce one unallocated
      // money row. The evidence identity decides; a replay returns the current
      // intent and writes nothing.
      const { recorded, evidenceId } = await recordPaymentEvidence(
        tx,
        context,
        current,
        {
          source: confirmation.source,
          method: confirmation.method,
          amountIdr: decision.amountIdr,
          providerRef: confirmation.providerRef,
          at: confirmation.at,
        },
      );
      if (!recorded) return current;
      const [row] = await tx
        .update(paymentIntents)
        .set({ flags: [...decision.flags], updatedAt: now })
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.id, current.id),
          ),
        )
        .returning();
      if (!row) throw new Error("Payment intent update returned no row");
      await tx.insert(paymentUnallocatedFunds).values({
        tenantId: context.tenant.tenantId,
        outletId: current.outletId,
        paymentIntentId: current.id,
        evidenceId,
        amountIdr: idr(decision.amountIdr),
        reason: "double_payment",
      });
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId: context.tenant.tenantId,
          outletId: current.outletId,
          ...auditActor,
          deviceId: null,
          action: "payment.double_payment_flagged",
          objectType: "payment_intent",
          objectId: current.id,
          reason: null,
          maskedChanges: {
            before: { status: current.status },
            after: {
              status: row.status,
              unallocatedIdr: decision.amountIdr,
              providerRef: confirmation.providerRef,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        ["status", "unallocatedIdr", "providerRef"],
      );
      return row;
    }

    // The bill may already be covered by another intent (a refreshed code
    // paid late): only the remainder is allocated, the rest is unallocated.
    // Evidence identity before any money write: a replay of this provider
    // transaction returns the committed state and records nothing.
    const { recorded, evidenceId } = await recordPaymentEvidence(
      tx,
      context,
      current,
      {
        source: confirmation.source,
        method: confirmation.method,
        amountIdr: confirmation.amountIdr,
        providerRef: confirmation.providerRef,
        at: confirmation.at,
      },
    );
    if (!recorded) return current;
    const allocatableNow = Math.min(
      current.amountIdr,
      outstandingIdr(freshLink),
    );
    const unallocatedNow = Math.max(0, confirmation.amountIdr - allocatableNow);
    const reasonNow: "overpayment" | "double_payment" | null =
      unallocatedNow === 0
        ? null
        : allocatableNow === 0
          ? "double_payment"
          : "overpayment";
    const flagsNow =
      reasonNow === "double_payment" &&
      !decision.flags.includes("double_payment")
        ? [...decision.flags, "double_payment" as const]
        : [...decision.flags];
    const [row] = await tx
      .update(paymentIntents)
      .set({
        status: "paid",
        paidAt: new Date(decision.paidAt),
        flags: flagsNow,
        providerRef: confirmation.providerRef,
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, current.id),
          eq(paymentIntents.status, current.status),
        ),
      )
      .returning();
    if (!row)
      throw new HttpError(
        409,
        "CONFLICT",
        "This payment was confirmed by another request.",
      );
    if (allocatableNow > 0)
      await tx
        .update(paymentLinks)
        .set({
          paidIdr: idr(freshLink.paidIdr + allocatableNow),
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentLinks.tenantId, context.tenant.tenantId),
            eq(paymentLinks.id, freshLink.id),
          ),
        );
    if (reasonNow !== null && unallocatedNow > 0)
      await tx.insert(paymentUnallocatedFunds).values({
        tenantId: context.tenant.tenantId,
        outletId: current.outletId,
        paymentIntentId: current.id,
        evidenceId,
        amountIdr: idr(unallocatedNow),
        reason: reasonNow,
      });
    await appendPaymentEvent(tx, context, {
      name: "payment.paid",
      aggregateId: row.id,
      outletId: row.outletId,
      actor:
        actor.type === "user"
          ? { type: "user", id: actor.id }
          : { type: "system" },
      payload: {
        intentId: row.id,
        paymentLinkId: row.paymentLinkId,
        method: row.method,
        provider: row.provider,
        amountIdr: row.amountIdr,
        receivedIdr: confirmation.amountIdr,
        allocatedIdr: allocatableNow,
        unallocatedIdr: unallocatedNow,
        providerRef: confirmation.providerRef,
        source: confirmation.source,
        paidAt: row.paidAt?.toISOString() ?? null,
        late: decision.late,
      },
      now,
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: row.outletId,
        ...auditActor,
        deviceId: null,
        action: "payment.paid",
        objectType: "payment_intent",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: { status: current.status },
          after: {
            status: row.status,
            amountIdr: row.amountIdr,
            receivedIdr: confirmation.amountIdr,
            allocatedIdr: allocatableNow,
            unallocatedIdr: unallocatedNow,
            providerRef: confirmation.providerRef,
            source: confirmation.source,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      [
        "status",
        "amountIdr",
        "receivedIdr",
        "allocatedIdr",
        "unallocatedIdr",
        "providerRef",
        "source",
      ],
    );
    return row;
  });
}

/**
 * PRD §3.13 "Failover": when the gateway is unusable the guest is told to pay
 * at the cashier. The acknowledgement is all the caller needs; the audit row
 * records the request for the opening supervisor (the in-app notification
 * needs a WS-05 notification event — follow-up bead).
 */
export async function requestPayAtCashier(
  context: ScopedTenantContext,
  token: string,
  now = new Date(),
): Promise<PayAtCashierAcknowledgement> {
  const parsedToken = paymentLinkTokenSchema.parse(token);
  const link = await loadLink(context, parsedToken, now);
  if (outstandingIdr(link) <= 0)
    throw new HttpError(409, "CONFLICT", "This bill is already paid.");
  await withTenant(db, context, async (tx) => {
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: link.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.pay_at_cashier_requested",
        objectType: "payment_link",
        objectId: link.id,
        reason: "gateway_failover",
        maskedChanges: { before: null, after: { reference: link.reference } },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["reference"],
    );
  });
  return payAtCashierAcknowledgementSchema.parse({
    requestedAt: now.toISOString(),
  });
}

/**
 * Expires every pending intent whose time is up (PRD "Siklus Pembayaran").
 * Safe to call repeatedly; each row transitions once and emits one event.
 */
export async function expireDueIntents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 200,
): Promise<{ expired: number }> {
  const due = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.status, "pending"),
          lte(paymentIntents.expiresAt, now),
        ),
      )
      .orderBy(asc(paymentIntents.expiresAt))
      .limit(limit),
  );
  let expired = 0;
  for (const row of due) {
    await expireIntent(context, row, now, "timeout");
    expired += 1;
  }
  return { expired };
}
