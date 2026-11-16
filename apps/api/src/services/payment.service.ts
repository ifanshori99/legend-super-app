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

import { createHash } from "node:crypto";
import {
  assertOutletInScope,
  createUlid,
  idr,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
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
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
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
import { auditLogs } from "../db/schema/core-audit";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import { paymentVaReleases } from "../db/schema/payment-va-release.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { recordAudit } from "./core-audit";
import {
  decidePaymentConfirmation,
  type PaymentConfirmation,
} from "./payment-lifecycle";
import {
  failOverLinkSafely,
  syncGatewayHealthSafely,
} from "./payment-failover.service";
import {
  billClosedForLateSettlement,
  lockBillOwner,
} from "./payment-late-settlement";
import { plausiblePaidAt } from "./payment-paid-at";
import {
  paymentGatewayFor,
  registeredGatewayProviders,
  type GatewayCancelRequest,
  type GatewayIntent,
  type OnlinePaymentMethod,
} from "./payment-gateway";
import {
  outletGatewayHealth,
  selectGatewayForNewIntent,
} from "./payment-gateway-select";
import {
  expiredCodeMayStillPay,
  failedCodeNotFinal,
  noVaRelease,
  providerAnswerFinal,
} from "./payment-live-code";
import {
  onlinePaymentMethodSchema,
  resolveRoutingRule,
  type ResolvedRouting,
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
/** Fixed RFC 9562 namespace for payment intent ids. Never change it: stored
 * intents and the DOIT `reference` of their payments were derived from it. */
const PAYMENT_INTENT_ID_NAMESPACE = Buffer.from(
  "6f1c2a4e8b3d4f5a9c7e2d1b0a3f4e5d",
  "hex",
);

/**
 * Deterministic intent id (UUID version 5) for one create request: the same
 * tenant and idempotency key always give the same id. The id is the DOIT
 * `reference` and the idempotency key is the DOIT Idempotency-Key, so a retry
 * after a lost gateway answer, or after a local write that failed once DOIT had
 * accepted the payment, sends the identical request: DOIT replays the payment
 * it already made, the adapter's reference check passes, and the retry stores
 * that payment. One DOIT payment, one local intent. A DOIT payment whose local
 * row was never written stays unpaid (the guest never received its code) until
 * such a retry binds it or it expires at DOIT.
 */
function intentIdFor(tenantId: string, idempotencyKey: string): string {
  const bytes = createHash("sha1")
    .update(PAYMENT_INTENT_ID_NAMESPACE)
    .update(`${tenantId}:${idempotencyKey}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
): Promise<Array<{ method: OnlinePaymentMethod; routing: ResolvedRouting }>> {
  return withTenant(db, context, async (tx) => {
    const routed = [];
    for (const method of ["qris", "va", "bank_transfer"] as const) {
      const routing = await resolveRoutingRule(
        tx,
        context,
        link.outletId,
        method,
      );
      routed.push({ method, routing });
    }
    return routed;
  });
}

async function onlineMethods(
  context: ScopedTenantContext,
  link: PaymentLinkRow,
): Promise<RoutedMethod[]> {
  const routed = await routeOnlineMethods(context, link);
  // Per method: the routing rule's provider, or its fallback when the primary
  // is down or disabled on the platform (sub-302 D4/D5).
  const selections = await Promise.all(
    routed.map((entry) =>
      selectGatewayForNewIntent(context, link.outletId, entry.routing),
    ),
  );
  const result: RoutedMethod[] = [];
  for (const [index, entry] of routed.entries()) {
    const selection = selections[index]!;
    const gatewayUsable = selection.provider !== null;
    const port = selection.provider
      ? selection.port
      : paymentGatewayFor(entry.routing.provider);
    // A down gateway is not asked for channels: its adapter may throw, and the
    // view must still render so the bill can fail over to the cashier.
    const channels =
      entry.method === "qris" || !gatewayUsable
        ? []
        : await port.channels(context, entry.method, link.outletId);
    const configured = entry.method === "qris" || channels.length > 0;
    const enabled = entry.routing.enabled && gatewayUsable && configured;
    const unavailableReason = !entry.routing.enabled
      ? ("routing_disabled" as const)
      : enabled
        ? null
        : gatewayUsable
          ? // Routing is on but no bank/channel is configured for the method.
            ("routing_disabled" as const)
          : ("gateway_down" as const);
    result.push({
      method: entry.method,
      provider: selection.provider ?? entry.routing.provider,
      enabled,
      unavailableReason,
      channels,
    });
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
    outletGatewayHealth(context, link.outletId),
    onlineMethods(context, link),
  ]);
  // PRD §3.13 Failover: a down gateway moves this bill to the cashier on its
  // own (one audit row per bill and incident, one supervisor alert per
  // incident); a healthy reading closes an open incident.
  const incident = await syncGatewayHealthSafely(
    context,
    link.outletId,
    health,
    now,
    health.provider,
  );
  if (incident?.openIncident != null && outstandingIdr(link) > 0)
    await failOverLinkSafely(context, link, incident.openIncident, now);
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
  /** Routing rule for a new intent; null when an idempotent retry found its
   * intent (an existing intent is never re-routed, PAY-05). */
  readonly routing: ResolvedRouting | null;
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
    readonly billSplitId: string | null;
  },
): void {
  if (
    existing.paymentLinkId !== request.paymentLinkId ||
    existing.method !== request.method ||
    existing.channelCode !== request.channelCode ||
    (existing.billSplitId ?? null) !== request.billSplitId
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
  part: SplitPartTarget | null,
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
        billSplitId: part?.billSplitId ?? null,
      });
      return { link, routing: null, existing };
    }
    if (outstandingIdr(link) <= 0)
      throw new HttpError(409, "CONFLICT", "This bill is already paid.");
    if (part && !splitPartFits(part.amountIdr, link))
      throw new HttpError(
        409,
        "CONFLICT",
        "This part is larger than the remaining balance. Reload and try again.",
      );
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
    return { link, routing, existing: null };
  });
}

/** One split part a guest pays on its own (D4). */
type SplitPartTarget = { billSplitId: string; amountIdr: number };

/** A part is payable while `0 < amount <= outstanding`. */
function splitPartFits(amountIdr: number, link: PaymentLinkRow): boolean {
  return amountIdr > 0 && amountIdr <= outstandingIdr(link);
}

/**
 * Supersedes the bill's pending codes; returns the ones a provider holds.
 * With `billSplitId` only that part's pending code is superseded.
 */
async function supersedePending(
  tx: Tx,
  context: ScopedTenantContext,
  link: PaymentLinkRow,
  now: Date,
  billSplitId?: string,
): Promise<GatewayCancelRequest[]> {
  const superseded: GatewayCancelRequest[] = [];
  // A gateway code already past its expiry is not live for the guest; it stays
  // `pending` so reconciliation keeps asking the gateway until it answers
  // definitively (see `syncPendingIntentDetailed`).
  const pending = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.paymentLinkId, link.id),
        eq(paymentIntents.status, "pending"),
        or(
          isNull(paymentIntents.providerRef),
          gt(paymentIntents.expiresAt, now),
        ),
        billSplitId === undefined
          ? undefined
          : eq(paymentIntents.billSplitId, billSplitId),
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
    if (row.providerRef !== null)
      superseded.push({
        intentId: row.id,
        provider: row.provider,
        providerRef: row.providerRef,
        outletId: row.outletId,
      });
  }
  return superseded;
}

/**
 * After the supersede committed: asks the provider to close the old codes so
 * a guest cannot still pay a VA they switched away from. Best effort; a
 * failure is logged and the old code, if paid anyway, is settled and refunded
 * through the normal verified path.
 */
async function cancelSupersededAtGateway(
  context: ScopedTenantContext,
  superseded: readonly GatewayCancelRequest[],
): Promise<void> {
  for (const intent of superseded) {
    // The code's own gateway, never the current routing (PAY-05).
    const gateway = paymentGatewayFor(intent.provider);
    if (!gateway.cancel) continue;
    try {
      await gateway.cancel(context, intent);
      // SO-889 P2-2: a cancel that resolved proves nothing (it is best effort).
      // Read the code's status; only a final answer (the code lapsed on its
      // own and the provider says expired / failed) marks it dead (SO-885).
      const now = new Date();
      const [row] = await withTenant(db, context, async (tx) =>
        tx
          .select({
            expiresAt: paymentIntents.expiresAt,
            gatewayIntegrationId: paymentIntents.gatewayIntegrationId,
          })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, context.tenant.tenantId),
              eq(paymentIntents.id, intent.intentId),
            ),
          ),
      );
      if (!row) continue;
      const answer = await gateway.getStatus({
        context,
        outletId: intent.outletId,
        integrationId: row.gatewayIntegrationId,
        providerRef: intent.providerRef,
        intentId: intent.intentId,
      });
      if (
        answer.providerRef !== intent.providerRef ||
        !providerAnswerFinal(
          { provider: intent.provider, expiresAt: row.expiresAt },
          answer,
          now,
        )
      )
        continue;
      await withTenant(db, context, async (tx) =>
        tx
          .update(paymentIntents)
          .set({ providerFinalAt: now })
          .where(
            and(
              eq(paymentIntents.tenantId, context.tenant.tenantId),
              eq(paymentIntents.id, intent.intentId),
              isNull(paymentIntents.providerFinalAt),
            ),
          ),
      );
    } catch (error) {
      // Identifiers only.
      logger.warn(
        { intentId: intent.intentId, err: error },
        "Payment: gateway cancel or status read of a superseded code failed",
      );
    }
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
  return createIntentCore(context, token, parsed, now, null);
}

/**
 * Creates one payable intent for a single split part (D4). The amount is the
 * part's, which must fit the link's outstanding balance; only that part's
 * pending code is superseded, so parts hold live codes side by side.
 */
export async function createSplitPartIntent(
  context: ScopedTenantContext,
  token: string,
  input: CreatePaymentIntentInput,
  part: { billSplitId: string; amountIdr: number },
  now = new Date(),
): Promise<CustomerPaymentIntent> {
  const parsed = createPaymentIntentInputSchema.parse(input);
  return createIntentCore(context, token, parsed, now, part);
}

async function createIntentCore(
  context: ScopedTenantContext,
  token: string,
  parsed: CreatePaymentIntentInput,
  now: Date,
  part: SplitPartTarget | null,
): Promise<CustomerPaymentIntent> {
  const plan = await readIntentPlan(context, token, parsed, now, part);
  if (plan.existing) return toCustomerIntent(plan.existing);
  const amountIdr = part ? part.amountIdr : outstandingIdr(plan.link);
  if (amountIdr <= 0)
    throw new HttpError(409, "CONFLICT", "This bill is already paid.");

  if (!plan.routing)
    throw new Error("Payment intent plan has neither an intent nor a route");
  const selected = await selectGatewayForNewIntent(
    context,
    plan.link.outletId,
    plan.routing,
  );
  if (selected.provider === null) {
    // No usable gateway for this outlet: record the outlet-level reading.
    const health = await outletGatewayHealth(context, plan.link.outletId);
    const incident = await syncGatewayHealthSafely(
      context,
      plan.link.outletId,
      health,
      now,
      health.provider,
    );
    if (incident?.openIncident != null)
      await failOverLinkSafely(context, plan.link, incident.openIncident, now);
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "The payment gateway is unavailable; pay at the cashier.",
    );
  }

  // The caller may shorten the lifetime (a QR guest's session ends sooner);
  // never lengthen it past the method default.
  const methodExpiry =
    now.getTime() + INTENT_LIFETIME_MINUTES[parsed.method] * 60_000;
  const callerExpiry =
    parsed.expiresAt === undefined
      ? methodExpiry
      : Date.parse(parsed.expiresAt);
  if (callerExpiry <= now.getTime())
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "The payment expiry must be in the future.",
    );
  const requestedExpiry = new Date(Math.min(methodExpiry, callerExpiry));
  // Same key, same id, same DOIT request: see intentIdFor.
  const intentId = intentIdFor(context.tenant.tenantId, parsed.idempotencyKey);
  const created: GatewayIntent = await selected.port.createIntent({
    context,
    outletId: plan.link.outletId,
    provider: selected.provider,
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

  let superseded: GatewayCancelRequest[] = [];
  try {
    const stored = await withTenant(db, context, async (tx) => {
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
          billSplitId: part?.billSplitId ?? null,
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
      if (
        part
          ? !splitPartFits(amountIdr, lockedLink)
          : outstandingIdr(lockedLink) !== amountIdr
      )
        throw new HttpError(
          409,
          "CONFLICT",
          "This bill changed while the payment was prepared. Reload and try again.",
        );
      superseded = await supersedePending(
        tx,
        context,
        plan.link,
        now,
        part?.billSplitId,
      );
      const [row] = await tx
        .insert(paymentIntents)
        .values({
          id: intentId,
          tenantId: context.tenant.tenantId,
          outletId: plan.link.outletId,
          paymentLinkId: plan.link.id,
          method: parsed.method,
          provider: selected.provider,
          amountIdr: idr(amountIdr),
          billSplitId: part?.billSplitId ?? null,
          idempotencyKey: parsed.idempotencyKey,
          providerRef: created.providerRef,
          gatewayIntegrationId: created.integrationId ?? null,
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
    await cancelSupersededAtGateway(context, superseded);
    return stored;
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
      billSplitId: part?.billSplitId ?? null,
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
  /** Also writes an audit row in the same transaction (an expiry the gateway
   * never confirmed, see `syncPendingIntentDetailed`). */
  audit?: { action: string; reason: string },
  /** SO-885: the PROVIDER answered final (or the money was reconciled). A
   * local timeout never sets it. */
  providerFinal = false,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const updated = await tx
      .update(paymentIntents)
      .set({
        status: "expired",
        updatedAt: now,
        ...(providerFinal ? { providerFinalAt: now } : {}),
      })
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
    if (!audit) return;
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: audit.action,
        objectType: "payment_intent",
        objectId: intent.id,
        reason: audit.reason,
        maskedChanges: {
          before: { status: "pending" },
          after: { status: "expired", providerRef: intent.providerRef },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["status", "providerRef"],
    );
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
  // A gateway code already past its expiry stays `pending`: it may still be
  // waiting for a definitive gateway answer, and expiring it here would take
  // it out of reconciliation (money paid with a lost webhook would never be
  // recorded). The poller settles it later as a late payment.
  const expired = await tx
    .update(paymentIntents)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, input.linkId),
        eq(paymentIntents.status, "pending"),
        or(
          isNull(paymentIntents.providerRef),
          gt(paymentIntents.expiresAt, input.now),
        ),
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
  /** SO-889: `providerAnswerFinal` held (the code lapsed on its own); a
   * `failed` answer before `expires_at` + 60 s may be a retryable attempt. */
  providerFinal = false,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const updated = await tx
      .update(paymentIntents)
      .set({
        status: "failed",
        updatedAt: now,
        ...(providerFinal ? { providerFinalAt: now } : {}),
      })
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

/**
 * A confirmation the lifecycle refused. Still a 409 CONFLICT for HTTP callers;
 * `decisionCode` lets internal callers (the polling fallback) tell an
 * underpayment (`AMOUNT_MISMATCH`, money arrived) from an untrusted source.
 */
export class PaymentConfirmationRejected extends HttpError {
  constructor(
    public decisionCode:
      | "UNTRUSTED_CONFIRMATION"
      | "AMOUNT_MISMATCH"
      | "INVALID_TRANSITION"
      | "BILL_CLOSED",
    message: string,
  ) {
    super(409, "CONFLICT", message);
    this.name = "PaymentConfirmationRejected";
  }
}

/**
 * Money arrived that cannot settle the intent: the intent is already closed as
 * failed (nothing revives it, lifecycle rule) or the paid amount does not match
 * the bill (AMOUNT_MISMATCH). The funds are recorded once, keyed by the
 * provider transaction, as unallocated funds for the existing refund or credit
 * review. Reason: `overpayment` when more than the bill was paid, otherwise
 * `double_payment` (the closest existing value: money that cannot be
 * allocated to this bill). The payment evidence row makes a replay, or the
 * same transaction seen by both webhook and poll, a no-op.
 */
type UnsettledGatewayFunds = {
  provider: string;
  providerRef: string;
  method?: PaymentIntentRow["method"];
  source: "verified_webhook" | "gateway_status";
  paidAmountIdr: number;
  receivedAt: Date;
};

export async function recordUnsettledGatewayFunds(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  funds: UnsettledGatewayFunds,
  now: Date,
): Promise<void> {
  await withTenant(db, context, (tx) =>
    recordUnsettledGatewayFundsInTx(tx, context, intent, funds, now),
  );
}

/** The same recording inside the caller's transaction (and lock order).
 * Returns false when nothing was recorded (a replay of the same provider
 * transaction, or no money). */
async function recordUnsettledGatewayFundsInTx(
  tx: Tx,
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  funds: UnsettledGatewayFunds,
  now: Date,
): Promise<boolean> {
  const paid = funds.paidAmountIdr;
  if (!(paid > 0)) return false;
  const reason =
    paid > Number(intent.amountIdr) ? "overpayment" : "double_payment";
  {
    const [inserted] = await tx
      .insert(paymentEvidence)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId,
        paymentIntentId: intent.id,
        provider: funds.provider,
        providerRef: funds.providerRef,
        method: funds.method ?? intent.method,
        source: funds.source,
        amountIdr: idr(paid),
        receivedAt: funds.receivedAt,
      })
      .onConflictDoNothing({
        target: [
          paymentEvidence.tenantId,
          paymentEvidence.provider,
          paymentEvidence.providerRef,
        ],
      })
      .returning({ id: paymentEvidence.id });
    if (!inserted) return false;
    const [fund] = await tx
      .insert(paymentUnallocatedFunds)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId,
        paymentIntentId: intent.id,
        // The payout refunds exactly this transaction (legend-knev).
        evidenceId: inserted.id,
        amountIdr: idr(paid),
        reason,
      })
      .returning({ id: paymentUnallocatedFunds.id });
    if (!fund) throw new Error("Unallocated funds insert returned no row");
    // No payment.paid books this money, so the receipt event is its own.
    await appendPaymentEvent(tx, context, {
      name: "payment.funds_unallocated",
      aggregateId: fund.id,
      outletId: intent.outletId,
      actor: { type: "system" },
      payload: {
        unallocatedFundId: fund.id,
        intentId: intent.id,
        method: funds.method ?? intent.method,
        provider: funds.provider,
        receivedIdr: paid,
        receivedAt: funds.receivedAt.toISOString(),
        reason,
      },
      now,
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.closed_intent_funds_flagged",
        objectType: "payment_intent",
        objectId: intent.id,
        reason: null,
        maskedChanges: {
          before: { status: intent.status },
          after: {
            status: intent.status,
            unallocatedIdr: paid,
            providerRef: funds.providerRef,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["status", "unallocatedIdr", "providerRef"],
    );
  }
  return true;
}

const MISMATCH_HELD_ACTION = "payment.amount_mismatch_held";

/** True when a held amount mismatch was recorded for this intent. */
async function amountMismatchHeld(
  tx: Tx,
  context: ScopedTenantContext,
  intentId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, context.tenant.tenantId),
        sql`${auditLogs.event}->>'action' = ${MISMATCH_HELD_ACTION}`,
        sql`${auditLogs.event}->>'objectId' = ${intentId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A signed gateway amount that differs from the bill (Codex legend-s0u8c, D2):
 * the intent is closed `failed` and marked held for review (an audit row,
 * `payment.amount_mismatch_held`, read back by `applyConfirmation`), and the
 * money is parked once as unallocated funds. Runs in one transaction in the
 * payment lock order (see `payment-late-settlement.ts`): bill owner, link,
 * intent. Funds are recorded even when the intent is already paid or settled
 * (the money did arrive); only an unpaid intent is failed and held.
 * legend-baz8i: when the money is newly parked and the intent has an unpaid
 * POS QRIS hold, the cashier and manager are alerted (the hold stays open
 * until a manager releases it); a replay parks and alerts nothing.
 */
export async function holdGatewayAmountMismatch(
  context: ScopedTenantContext,
  intentId: string,
  input: {
    providerRef: string;
    paidAmountIdr: number;
    eventId?: string;
    source: "webhook" | "gateway_status";
  },
  now: Date,
): Promise<{ held: boolean; intentStatus: PaymentIntentRow["status"] }> {
  return withTenant(db, context, async (tx) => {
    const [probe] = await tx
      .select({ paymentLinkId: paymentIntents.paymentLinkId })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    if (!probe) throw new HttpError(404, "NOT_FOUND", "Payment not found.");
    await lockBillOwner(tx, context, probe.paymentLinkId);
    await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.id, probe.paymentLinkId),
        ),
      )
      .for("update");
    const current = await lockedIntent(tx, context, intentId);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Payment not found.");
    let status = current.status;
    let held = false;
    // SO-896 P2-3: a code that was already `expired` (superseded, voided, timed
    // out) is over once its money arrived. A `pending` one fails here and, like
    // any failed code, stays live until the provider answers final.
    const wasExpired = status === "expired";
    if (status === "pending" || status === "expired") {
      await tx
        .update(paymentIntents)
        .set({ status: "failed", updatedAt: now })
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.id, current.id),
          ),
        );
      await appendPaymentEvent(tx, context, {
        name: "payment.failed",
        aggregateId: current.id,
        outletId: current.outletId,
        actor: { type: "system" },
        payload: { intentId: current.id, reason: "amount_mismatch" },
        now,
      });
      status = "failed";
    }
    held = status === "failed";
    // The mismatch is recorded even when the intent was already paid (the
    // audit trail keeps the evidence); only a failed intent is held.
    if (!(await amountMismatchHeld(tx, context, current.id)))
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId: context.tenant.tenantId,
          outletId: current.outletId,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: MISMATCH_HELD_ACTION,
          objectType: "payment_intent",
          objectId: current.id,
          reason: null,
          maskedChanges: {
            before: { status: current.status },
            after: {
              status,
              paidIdr: input.paidAmountIdr,
              dueIdr: Number(current.amountIdr),
              source: input.source,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        ["status", "paidIdr", "dueIdr", "source"],
      );
    const inserted = await recordUnsettledGatewayFundsInTx(
      tx,
      context,
      { ...current, status },
      {
        provider: current.provider,
        providerRef: input.providerRef,
        source:
          input.source === "webhook" ? "verified_webhook" : "gateway_status",
        paidAmountIdr: input.paidAmountIdr,
        receivedAt: now,
      },
      now,
    );
    // The money that arrived on an expired code ends it for good (as the poll
    // does when it parks): else it stays live after the money is refunded and
    // blocks the replacement code.
    if (wasExpired)
      await markGatewayReconciledInTx(tx, context, current.id, now);
    // legend-baz8i: newly parked money for a POS QRIS hold alerts the cashier
    // and the manager. The hold stays as is (the manager releases it); a
    // replay (not inserted) parks and alerts nothing more.
    if (inserted) {
      const [hold] = await tx
        .select({
          id: posQrisHolds.id,
          state: posQrisHolds.state,
          openedBy: posQrisHolds.openedBy,
        })
        .from(posQrisHolds)
        .where(
          and(
            eq(posQrisHolds.tenantId, context.tenant.tenantId),
            eq(posQrisHolds.paymentIntentId, current.id),
          ),
        );
      if (hold && hold.state !== "paid") {
        // The unlock wording only fits a hold that is still locked; a closed
        // hold keeps the helper's default text. A callback amount that
        // disagrees with the provider's status answer is not "different from
        // the bill", so it gets its own wording.
        const dueIdr = Number(current.amountIdr);
        const body =
          hold.state === "closed"
            ? undefined
            : input.paidAmountIdr === dueIdr
              ? `Nominal callback QRIS dan status penyedia tidak cocok (Rp${input.paidAmountIdr}). Uang ditahan di dana belum teralokasi; minta manajer membuka kunci QR dan mengembalikan uang ke pembayar.`
              : `QR QRIS dibayar dengan nominal Rp${input.paidAmountIdr}, berbeda dari tagihan Rp${dueIdr}. Uang ditahan di dana belum teralokasi; minta manajer membuka kunci QR dan mengembalikan uang ke pembayar.`;
        await alertQrisFundsParked(
          tx,
          context,
          current,
          hold,
          input.paidAmountIdr,
          now,
          body,
        );
      }
    }
    return { held, intentStatus: status };
  });
}

type SyncResult = {
  intent: PaymentIntentRow;
  /** True when the gateway call failed and the answer is unknown. */
  gatewayError: boolean;
};

/**
 * Gateways whose status answer settles only the exact bill, and whose late
 * payment settles only an open bill (Codex legend-rgddb, CTO decision): any
 * other paid answer is parked as unallocated funds for reconciliation.
 */
const STRICT_SETTLEMENT_PROVIDERS: ReadonlySet<string> = new Set(["duitku"]);

/** A strict provider's amount difference is held for review (the intent
 * fails, the money is parked, see `holdGatewayAmountMismatch`), then refused
 * with the lifecycle's own error so the callers' parking path stays a no-op. */
async function assertStrictAmount(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  paid: { providerRef: string; amountIdr: number },
  now: Date,
): Promise<void> {
  const paidAmountIdr = paid.amountIdr;
  if (
    STRICT_SETTLEMENT_PROVIDERS.has(intent.provider) &&
    paidAmountIdr !== Number(intent.amountIdr)
  ) {
    await holdGatewayAmountMismatch(
      context,
      intent.id,
      {
        providerRef: paid.providerRef,
        paidAmountIdr,
        source: "gateway_status",
      },
      now,
    );
    throw new PaymentConfirmationRejected(
      "AMOUNT_MISMATCH",
      "The gateway amount differs from the bill.",
    );
  }
}

const strictOptions = (intent: PaymentIntentRow) => ({
  closedIntentNeedsOpenBill: STRICT_SETTLEMENT_PROVIDERS.has(intent.provider),
});

/** Money that arrived but must not settle the intent: parked, not lost. */
const parksFunds = (error: unknown): boolean =>
  error instanceof PaymentConfirmationRejected &&
  (error.decisionCode === "AMOUNT_MISMATCH" ||
    error.decisionCode === "BILL_CLOSED");

/**
 * Applies a provider status without inventing one (PAY-02). Past its expiry a
 * pending intent with a provider reference asks the gateway first: money may
 * have arrived after the code lapsed, and the lifecycle flags that as a late
 * payment. A paid answer is recorded at the provider's own `paid_at`, so a
 * payment made before expiry but polled after it is not late.
 *
 * Only a definitive answer closes a lapsed intent. A gateway error (or a paid
 * answer without the amount) proves nothing, so the intent stays `pending`
 * and the poller keeps asking with backoff; after `GATEWAY_POLL_WINDOW_MS`
 * past expiry it is expired as `timeout` with an audit row. Any other answer
 * past expiry expires it as before.
 */
async function syncPendingIntentDetailed(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
): Promise<SyncResult> {
  if (intent.status !== "pending") return { intent, gatewayError: false };
  const pastExpiry = intent.expiresAt <= now;
  if (intent.providerRef === null) {
    if (!pastExpiry) return { intent, gatewayError: false };
    await expireIntent(context, intent, now, "timeout");
    return {
      intent: { ...intent, status: "expired", updatedAt: now },
      gatewayError: false,
    };
  }
  let providerStatus;
  let gatewayError = false;
  let settlementFailed = false;
  // The provider's paid money was recorded as unallocated funds (SO-885).
  let fundsParked = false;
  try {
    providerStatus = await paymentGatewayFor(intent.provider).getStatus({
      context,
      outletId: intent.outletId,
      integrationId: intent.gatewayIntegrationId,
      providerRef: intent.providerRef,
      intentId: intent.id,
    });
  } catch {
    // Gateway outage: the stored status stays; the link view reports it down.
    gatewayError = true;
  }
  if (providerStatus?.status === "paid" && providerStatus.amountIdr !== null) {
    // Fail closed: a status answer without the settled amount proves nothing
    // about how much arrived; the verified webhook settles it instead (PAY-02).
    const paidAt = plausiblePaidAt(
      providerStatus.paidAt,
      intent.createdAt,
      now,
    );
    try {
      await assertStrictAmount(
        context,
        intent,
        {
          providerRef: providerStatus.providerRef,
          amountIdr: providerStatus.amountIdr,
        },
        now,
      );
      return {
        intent: await applyConfirmation(
          context,
          intent,
          {
            source: "gateway_status",
            method: intent.method,
            amountIdr: providerStatus.amountIdr,
            providerRef: providerStatus.providerRef,
            at: paidAt,
          },
          { type: "system" },
          now,
          strictOptions(intent),
        ),
        gatewayError: false,
      };
    } catch (error) {
      // An underpayment (or, for a strict provider, any amount difference or
      // a late payment on a closed bill) is money that arrived: park it before
      // the intent is expired or the error surfaces, so a lost webhook never
      // loses funds.
      if (parksFunds(error)) {
        await recordUnsettledGatewayFunds(
          context,
          intent,
          {
            provider: intent.provider,
            providerRef: providerStatus.providerRef,
            source: "gateway_status",
            paidAmountIdr: providerStatus.amountIdr,
            receivedAt: new Date(paidAt),
          },
          now,
        );
        fundsParked = true;
      }
      // Past expiry a rejected settlement (409) must not surface on the link
      // view: fall through and expire the intent instead.
      if (!pastExpiry) throw error;
      // A non-definitive failure (DB, serialization) proves nothing: the money
      // may still settle on the next poll, so it must not expire the intent.
      if (!(error instanceof PaymentConfirmationRejected))
        settlementFailed = true;
    }
  }
  // SO-896: an answer about another reference says nothing about this code.
  const aboutThisCode = providerStatus?.providerRef === intent.providerRef;
  if (pastExpiry) {
    // A provider that still says `pending` past our expiry can still take the
    // money (its own expiry may lag ours): only paid / expired / failed are
    // definitive, so `pending` keeps reconciling like a gateway error does.
    const inconclusive =
      providerStatus === undefined ||
      settlementFailed ||
      (providerStatus.status !== "paid" && !aboutThisCode) ||
      providerStatus.status === "pending" ||
      (providerStatus.status === "paid" && providerStatus.amountIdr === null);
    if (inconclusive) {
      // Money may have arrived: keep reconciling until the window closes.
      if (now.getTime() - intent.expiresAt.getTime() < GATEWAY_POLL_WINDOW_MS)
        return { intent, gatewayError };
      await expireIntent(context, intent, now, "timeout", {
        action: "payment.reconciliation_timed_out",
        reason: gatewayError ? "gateway_unreachable" : "gateway_unconfirmed",
      });
      return {
        intent: { ...intent, status: "expired", updatedAt: now },
        gatewayError,
      };
    }
    // SO-885: final proof only when the provider said expired / failed, or its
    // paid money was parked as unallocated funds. A paid answer whose
    // confirmation was refused (untrusted source, invalid transition) is NOT
    // reconciled: the code stays collectible and in the poll, and the audit row
    // alerts staff.
    const providerFinal =
      (providerStatus !== undefined &&
        aboutThisCode &&
        providerAnswerFinal(intent, providerStatus, now)) ||
      fundsParked;
    await expireIntent(
      context,
      intent,
      now,
      "timeout",
      providerFinal
        ? undefined
        : {
            action: "payment.provider_paid_confirmation_rejected",
            reason: "provider_paid_not_recorded",
          },
      providerFinal,
    );
    return {
      intent: { ...intent, status: "expired", updatedAt: now },
      gatewayError,
    };
  }
  if (providerStatus === undefined) return { intent, gatewayError };
  if (providerStatus.status === "expired") {
    await expireIntent(
      context,
      intent,
      now,
      "gateway",
      undefined,
      aboutThisCode && providerAnswerFinal(intent, providerStatus, now),
    );
    return {
      intent: { ...intent, status: "expired", updatedAt: now },
      gatewayError: false,
    };
  }
  if (providerStatus.status === "failed") {
    await failIntent(
      context,
      intent,
      now,
      aboutThisCode && providerAnswerFinal(intent, providerStatus, now),
    );
    return {
      intent: { ...intent, status: "failed", updatedAt: now },
      gatewayError: false,
    };
  }
  return { intent, gatewayError: false };
}

async function syncPendingIntent(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
): Promise<PaymentIntentRow> {
  return (await syncPendingIntentDetailed(context, intent, now)).intent;
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
  return shownIntentView(current, now);
}

/**
 * legend-eqeu7: `getIntentView` asks the provider and settles a paid answer
 * (`applyConfirmation` opens its own transaction and waits for the bill
 * owner's row lock), so it must never run in a transaction that already holds
 * that lock. A caller that holds the lock first syncs with `getIntentView`
 * outside it, then reads again under the lock with this: stored state only,
 * no provider call and no settlement.
 */
export async function readIntentView(
  context: ScopedTenantContext,
  token: string,
  intentId: string,
  now = new Date(),
): Promise<CustomerPaymentIntent> {
  const parsedToken = paymentLinkTokenSchema.parse(token);
  const { intent } = await loadIntent(context, parsedToken, intentId, now);
  return shownIntentView(intent, now);
}

function shownIntentView(
  current: PaymentIntentRow,
  now: Date,
): CustomerPaymentIntent {
  // A lapsed code the gateway has not confirmed yet stays `pending` in the
  // database for reconciliation; the guest sees it as expired.
  const shown: PaymentIntentRow =
    current.status === "pending" && current.expiresAt <= now
      ? { ...current, status: "expired" }
      : current;
  return customerPaymentIntentSchema.parse(toCustomerIntent(shown));
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
  // A lapsed code kept `pending` for reconciliation is replaced like an
  // expired one (supersede leaves it pending, see `supersedePending`).
  if (current.status === "pending" && current.expiresAt > now)
    return toCustomerIntent(current);
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
  // If a create succeeded at the gateway but the local write threw, a retry
  // under the same key gets the same intent id (intentIdFor), so the gateway
  // replays that payment and the retry binds it. A replay answers the old
  // amount, which the adapter refuses, so the key also carries the current
  // balance (a changed bill gets a new key) and the minute (any other failure
  // clears within a minute), while repeated taps within that minute still
  // share one key and recover a lost answer. Well under 100 chars.
  const minute = Math.floor(now.getTime() / 60_000);
  const idempotencyKey =
    `refresh:${link.id}:${count}:${outstandingIdr(link)}:${minute}`.slice(
      0,
      100,
    );
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
 * legend-baz8i: after money was newly parked for a POS QRIS that has a hold
 * (the caller saw `recordUnsettledGatewayFundsInTx` insert), slow the hold
 * check to once a day (nothing more to learn from the provider; the hold
 * itself stays until a manager releases it) and alert the outlet supervisors,
 * owners and the cashier who issued the QR (guests have no opener). Runs in
 * the caller's transaction; never changes the hold's state.
 */
async function alertQrisFundsParked(
  tx: Tx,
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  hold: { id: string; openedBy: string | null },
  paidAmountIdr: number,
  now: Date,
  body = `Pembayaran QRIS Rp${paidAmountIdr} masuk untuk QR yang sudah ditutup atau nominalnya berbeda. Uang ditahan di dana belum teralokasi; kembalikan ke pembayar.`,
): Promise<void> {
  await tx
    .update(posQrisHolds)
    .set({ nextCheckAt: new Date(now.getTime() + 24 * 3_600_000) })
    .where(
      and(
        eq(posQrisHolds.tenantId, context.tenant.tenantId),
        eq(posQrisHolds.id, hold.id),
        inArray(posQrisHolds.state, ["open", "cancelling"]),
      ),
    );
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: context.tenant.tenantId,
      outletId: intent.outletId as OutletId,
      alsoOwners: true,
      alsoUserIds: hold.openedBy ? [hold.openedBy] : [],
      id: createUlid(now.getTime()),
      eventName: "payment_qris_funds.parked",
      aggregateType: "payment_qris_funds",
      aggregateId: intent.id,
      payload: { intentId: intent.id, holdId: hold.id },
      title: "Uang QRIS perlu dikembalikan",
      body,
    },
    now,
  );
}

/**
 * legend-yhia9 D-05/D-07: money for a POS QRIS that has a hold is applied only
 * when the hold is still active and the amount is exactly the hold's. A closed
 * hold (provider proof or manager release) or a different amount never settles
 * the bill: the money is parked as unallocated funds (the manager returns it),
 * the outlet manager is alerted, and the usual 409 follows. Intents without a
 * hold (cards, QR-table, legacy tenders) are untouched. Replays are no-ops (the
 * evidence key makes parking once-only; an already applied hold is `paid`).
 * legend-eh9i4 A1: runs inside `applyConfirmation`, under the bill + intent
 * locks, so webhook and polling share it. The caller throws after commit.
 */
async function parkWhenQrisHoldRefusesInTx(
  tx: Tx,
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  paid: {
    providerRef: string;
    amountIdr: number;
    source: string;
    at: string;
  },
  now: Date,
): Promise<
  | null
  | { kind: "replay" }
  | { kind: "reject"; code: "AMOUNT_MISMATCH" | "BILL_CLOSED" }
> {
  // legend-5wn1e: a VA code staff released (supervisor override, no provider
  // proof) never settles the bill again: money that arrives for it is always
  // parked as unallocated funds, keyed by the provider transaction, so webhook
  // and poll together park it exactly once and the order cannot be paid twice.
  const [vaRelease] = await tx
    .select({
      id: paymentVaReleases.id,
      releasedBy: paymentVaReleases.releasedBy,
    })
    .from(paymentVaReleases)
    .where(
      and(
        eq(paymentVaReleases.tenantId, context.tenant.tenantId),
        eq(paymentVaReleases.paymentIntentId, intent.id),
      ),
    );
  if (vaRelease) {
    const inserted = await recordUnsettledGatewayFundsInTx(
      tx,
      context,
      intent,
      {
        provider: intent.provider,
        providerRef: paid.providerRef,
        source:
          paid.source === "verified_webhook"
            ? "verified_webhook"
            : "gateway_status",
        paidAmountIdr: paid.amountIdr,
        receivedAt:
          paid.source === "verified_webhook" ? now : new Date(paid.at),
      },
      now,
    );
    // A replay of the same provider transaction records and alerts nothing.
    if (!inserted) return { kind: "replay" };
    await notifyOutletSupervisors(
      tx,
      context,
      {
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId as OutletId,
        alsoOwners: true,
        alsoUserIds: vaRelease.releasedBy ? [vaRelease.releasedBy] : [],
        id: createUlid(now.getTime()),
        eventName: "payment_va_funds.parked",
        aggregateType: "payment_va_funds",
        aggregateId: intent.id,
        payload: { intentId: intent.id, releaseId: vaRelease.id },
        title: "Uang VA perlu dikembalikan",
        body: `Pembayaran VA Rp${paid.amountIdr} masuk untuk kode VA yang sudah dirilis staf. Uang ditahan di dana belum teralokasi; kembalikan ke pembayar.`,
      },
      now,
    );
    return { kind: "reject", code: "BILL_CLOSED" };
  }
  const [hold] = await tx
    .select({
      id: posQrisHolds.id,
      state: posQrisHolds.state,
      amountIdr: posQrisHolds.amountIdr,
      openedBy: posQrisHolds.openedBy,
      closeEvidence: posQrisHolds.closeEvidence,
    })
    .from(posQrisHolds)
    .where(
      and(
        eq(posQrisHolds.tenantId, context.tenant.tenantId),
        eq(posQrisHolds.paymentIntentId, intent.id),
      ),
    );
  if (!hold || hold.state === "paid") return null;
  const mismatch = paid.amountIdr !== Number(hold.amountIdr);
  // legend-w0ows (founder Q7): a hold ended because a card sale booked the
  // bill is not parked; the payment settles like any payment on a voided
  // tender, so the late-payment path refunds the customer in full.
  const endedByCardSale =
    hold.state === "closed" &&
    (hold.closeEvidence as { anomaly?: unknown } | null)?.anomaly ===
      "card_sale_booked";
  if (endedByCardSale && !mismatch) return null;
  if (hold.state !== "closed" && !mismatch) return null;
  {
    const inserted = await recordUnsettledGatewayFundsInTx(
      tx,
      context,
      intent,
      {
        provider: intent.provider,
        providerRef: paid.providerRef,
        source:
          paid.source === "verified_webhook"
            ? "verified_webhook"
            : "gateway_status",
        paidAmountIdr: paid.amountIdr,
        // Webhook: arrival time. Polling: the provider's paid time, so the
        // unallocated-funds date is not shifted by when the poll ran.
        receivedAt:
          paid.source === "verified_webhook" ? now : new Date(paid.at),
      },
      now,
    );
    // A replay of the same provider transaction records and alerts nothing.
    if (!inserted) return { kind: "replay" };
    await alertQrisFundsParked(tx, context, intent, hold, paid.amountIdr, now);
    return {
      kind: "reject",
      code: mismatch ? "AMOUNT_MISMATCH" : "BILL_CLOSED",
    };
  }
}

/**
 * PAY-02/PAY-04: applies one verified confirmation. The caller must already
 * have verified the evidence (webhook signature, EDC ECR result, authorized
 * cash officer); this function decides what that evidence may change.
 */
export async function confirmPayment(
  context: ScopedTenantContext,
  intentId: string,
  confirmation: PaymentConfirmationInput & {
    /** First receipt of the signed evidence; bounds `paidAt` of a still
     * pending intent (decided under the lock, never before the call). */
    receivedAt?: Date;
  },
  actor: PaymentActor = { type: "system" },
  now = new Date(),
  options: { closedIntentNeedsOpenBill?: boolean } = {},
): Promise<PaymentIntent> {
  // The strict schema refuses unknown keys, `receivedAt` is not evidence.
  const evidence = { ...confirmation };
  delete evidence.receivedAt;
  const parsed = paymentConfirmationSchema.parse(evidence);
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
      receivedAt: confirmation.receivedAt,
    },
    actor,
    now,
    options,
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
  rawConfirmation: PaymentConfirmation & { receivedAt?: Date },
  actor: PaymentActor,
  now: Date,
  options: { closedIntentNeedsOpenBill?: boolean } = {},
): Promise<PaymentIntentRow> {
  const auditActor = auditActorOf(actor);
  let holdRefusal: "AMOUNT_MISMATCH" | "BILL_CLOSED" | null = null;
  const applied = await withTenant(db, context, async (tx) => {
    // PAY-04 concurrency, lock order in `payment-late-settlement.ts`: bill
    // owner, then the bill row (FOR UPDATE) before reading its balance, then
    // the intent row. Every settlement writer takes the locks in this order,
    // so two settlements for different intents serialize on the bill and two
    // for the same intent serialize on both; the decision below is always
    // made from the committed, locked state — never from a snapshot read
    // before another delivery settled the intent.
    await lockBillOwner(tx, context, intent.paymentLinkId);
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
    // QRIS hold (legend-yhia9 D-05/D-07, legend-eh9i4 A1): the money is parked
    // here, under the same locks, for webhook and polling alike. The rejection
    // is thrown after this transaction commits so the parking is kept.
    const parked = await parkWhenQrisHoldRefusesInTx(
      tx,
      context,
      current,
      rawConfirmation,
      now,
    );
    if (parked) {
      if (parked.kind === "reject") holdRefusal = parked.code;
      return current;
    }
    // A strict provider's amount mismatch holds the intent for review: a later
    // delivery for the same intent may not settle it, whatever amount it says.
    if (
      options.closedIntentNeedsOpenBill &&
      current.status === "failed" &&
      (await amountMismatchHeld(tx, context, current.id))
    )
      throw new PaymentConfirmationRejected(
        "AMOUNT_MISMATCH",
        "This payment is held for an amount mismatch.",
      );
    // paidAt from the LOCKED status: a still pending intent was paid no later
    // than the first receipt; a closed one was paid after it closed, so never
    // before its close time (`now` is taken when the caller started, which can
    // be before a close committed while it waited on the gateway or the lock).
    const { receivedAt, ...base } = rawConfirmation;
    const closedAt = new Date(current.updatedAt).getTime();
    const confirmation: PaymentConfirmation =
      receivedAt !== undefined || options.closedIntentNeedsOpenBill
        ? {
            ...base,
            at: (current.status === "pending"
              ? (receivedAt ?? now).getTime() < now.getTime()
                ? (receivedAt as Date)
                : now
              : closedAt > now.getTime()
                ? new Date(closedAt)
                : now
            ).toISOString(),
          }
        : base;
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
      throw new PaymentConfirmationRejected(decision.code, decision.message);
    // Opt-in late settlement guard: a pending, failed or expired intent may
    // only settle a bill that is still open. Checked under the bill + intent locks above
    // and before any write, so the caller can park the money as unallocated.
    if (
      options.closedIntentNeedsOpenBill &&
      decision.kind === "settle" &&
      (await billClosedForLateSettlement(tx, context, freshLink, current))
    )
      throw new PaymentConfirmationRejected(
        "BILL_CLOSED",
        "The bill of this closed payment is already settled or cancelled.",
      );

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
      const [fund] = await tx
        .insert(paymentUnallocatedFunds)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: current.outletId,
          paymentIntentId: current.id,
          evidenceId,
          amountIdr: idr(decision.amountIdr),
          reason: "double_payment",
        })
        .returning({ id: paymentUnallocatedFunds.id });
      if (!fund) throw new Error("Unallocated funds insert returned no row");
      // The intent is already paid: no payment.paid books this money.
      await appendPaymentEvent(tx, context, {
        name: "payment.funds_unallocated",
        aggregateId: fund.id,
        outletId: current.outletId,
        actor:
          actor.type === "user"
            ? { type: "user", id: actor.id }
            : { type: "system" },
        payload: {
          unallocatedFundId: fund.id,
          intentId: current.id,
          method: confirmation.method,
          provider: current.provider,
          receivedIdr: decision.amountIdr,
          receivedAt: new Date(confirmation.at).toISOString(),
          reason: "double_payment",
        },
        now,
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
            late: decision.late,
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
        "late",
      ],
    );
    return row;
  });
  if (holdRefusal)
    throw new PaymentConfirmationRejected(
      holdRefusal,
      "This payment cannot settle its bill; the money is parked.",
    );
  return applied;
}

/**
 * PRD §3.13 "Failover": when the gateway is unusable the guest is told to pay
 * at the cashier. The acknowledgement is all the caller needs; the audit row
 * records the request for the cashier. Asking twice answers the first time and
 * writes nothing more. No money column is touched, and it never waits on the
 * gateway: the cashier fallback must work exactly when the gateway hangs. The
 * incident and its supervisor alert come from the bill screen's own health
 * reading (payment-failover.service.ts).
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
  const requestedAt = await withTenant(db, context, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legend:pay-at-cashier:${context.tenant.tenantId}:${link.id}`}, 0))`,
    );
    const [first] = await tx
      .select({ requestedAt: sql<string>`${auditLogs.event}->>'createdAt'` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, context.tenant.tenantId),
          eq(auditLogs.outletId, link.outletId),
          gte(auditLogs.createdAt, link.createdAt),
          sql`${auditLogs.event}->>'action' = 'payment.pay_at_cashier_requested'`,
          sql`${auditLogs.event}->>'objectId' = ${link.id}`,
        ),
      )
      .orderBy(asc(auditLogs.createdAt))
      .limit(1);
    if (first) return new Date(first.requestedAt);
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
    return now;
  });
  return payAtCashierAcknowledgementSchema.parse({
    requestedAt: requestedAt.toISOString(),
  });
}

/**
 * Expires every pending intent whose time is up (PRD "Siklus Pembayaran").
 * Safe to call repeatedly; each row transitions once and emits one event.
 *
 * `leaveGatewayReconciling` (the worker sweep, legend-jf4i) skips a code the
 * installed gateway issued (provider + provider reference): money may still
 * land after it lapsed, so the polling fallback keeps asking and expires it as
 * `timeout` (audited) once `GATEWAY_POLL_WINDOW_MS` has passed. Only codes with
 * no gateway behind them lapse here.
 */
export async function expireDueIntents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 200,
  options: { leaveGatewayReconciling?: boolean } = {},
): Promise<{ expired: number }> {
  const providers = registeredGatewayProviders();
  const gatewayOwned = and(
    isNotNull(paymentIntents.providerRef),
    providers.length > 0
      ? inArray(paymentIntents.provider, [...providers])
      : sql`false`,
  );
  const due = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.status, "pending"),
          lte(paymentIntents.expiresAt, now),
          options.leaveGatewayReconciling ? not(gatewayOwned!) : undefined,
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

// ------------------------------------------- gateway webhook and polling

/** How long a pending intent is left to the verified webhook before the
 * polling fallback asks the gateway (PRD PAY-02/03). */
export const GATEWAY_POLL_GRACE_MS = 60_000;

/** How long past its expiry a gateway code is still reconciled. A pending
 * intent the gateway never answered for is expired as `timeout` (audited)
 * after it; an expired (superseded) code is no longer asked about. */
export const GATEWAY_POLL_WINDOW_MS = 24 * 60 * 60_000;

/** Longest wait between two polls of a lapsed code. Before it, the wait is
 * half the time since expiry (1, 2, 4… minutes), so a lapsed code costs a
 * few dozen gateway calls over the whole window, not one per tick. */
export const GATEWAY_POLL_MAX_BACKOFF_MS = 60 * 60_000;

/** Time budget of one polling run, and how many gateway errors in a row end it. */
export const GATEWAY_POLL_BUDGET_MS = 20_000;
export const GATEWAY_POLL_MAX_CONSECUTIVE_ERRORS = 3;

/** How long a worker holds the intents it claimed for a polling run. It is
 * released when the run ends; this only matters when a worker dies mid-run, so
 * it must outlast the run budget with room to spare. */
export const GATEWAY_POLL_LEASE_MS = 2 * 60_000;

/**
 * Applies a verified provider "expired"/"failed" outcome. It acts only while
 * the intent is still `pending`: the conditional UPDATE re-checks the status
 * under the row lock, so a paid (or otherwise settled) intent is never
 * downgraded by a late or out-of-order delivery. Returns the current intent.
 */
export async function applyGatewayFailure(
  context: ScopedTenantContext,
  intentId: string,
  outcome: "expired" | "failed",
  now = new Date(),
  /** The provider's own code (Duitku `02`) when the caller read it. */
  rawStatus?: string,
): Promise<PaymentIntent> {
  const id = uuidSchema.parse(intentId);
  const load = () =>
    withTenant(db, context, async (tx) => {
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
  const intent = await load();
  if (!intent) throw new HttpError(404, "NOT_FOUND", "Payment not found.");
  assertOutletInScope(context.outletScope, intent.outletId);
  // SO-889: a verified answer is final only once the code lapsed on its own.
  const final = providerAnswerFinal(
    intent,
    { status: outcome, rawStatus },
    now,
  );
  if (intent.status === "pending") {
    if (outcome === "expired")
      await expireIntent(context, intent, now, "gateway", undefined, final);
    else await failIntent(context, intent, now, final);
  } else if (
    (intent.status === "expired" || intent.status === "failed") &&
    final
  ) {
    // A superseded / timed-out / failed code: the provider's verified final
    // answer, after the code lapsed, is the proof it is dead (SO-885, SO-896).
    await markGatewayReconciled(context, intent, now);
  }
  const current = (await load()) ?? intent;
  return toPaymentIntent(current);
}

/** SO-896: an `expired` or `failed` code (both can still be paid until the
 * provider answers final) is read by `syncExpiredIntentPayment`. */
function isClosedPollable(intent: { status: string }): boolean {
  return intent.status === "expired" || intent.status === "failed";
}

/**
 * A superseded (or voided-bill) intent is `expired` in our database, but its
 * gateway payment stays payable until its own expiry. Asks the gateway about
 * it: a paid answer settles through the lifecycle (flagged `late_payment`), an
 * underpayment is parked as unallocated funds, any other answer changes
 * nothing (never re-expires, never emits events).
 *
 * Such an intent was closed before its code lapsed (`updated_at <
 * expires_at`), and the poller keeps asking until a definitive answer arrives
 * after the code lapsed (see `markGatewayReconciled`); a gateway error, or a
 * provider still reporting `pending`, keeps it in the poll.
 */
async function syncExpiredIntentPayment(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
): Promise<SyncResult> {
  if (!isClosedPollable(intent) || intent.providerRef === null)
    return { intent, gatewayError: false };
  let providerStatus;
  try {
    providerStatus = await paymentGatewayFor(intent.provider).getStatus({
      context,
      outletId: intent.outletId,
      integrationId: intent.gatewayIntegrationId,
      providerRef: intent.providerRef,
      intentId: intent.id,
    });
  } catch {
    return { intent, gatewayError: true };
  }
  if (
    providerStatus.status === "expired" ||
    providerStatus.status === "failed"
  ) {
    // SO-889: final only once the code lapsed on its own (+ margin); before
    // that the poll keeps asking.
    if (
      providerStatus.providerRef === intent.providerRef &&
      providerAnswerFinal(intent, providerStatus, now)
    )
      await markGatewayReconciled(context, intent, now);
    return { intent, gatewayError: false };
  }
  if (providerStatus.status !== "paid" || providerStatus.amountIdr === null)
    return { intent, gatewayError: false };
  const paidAt = plausiblePaidAt(providerStatus.paidAt, intent.createdAt, now);
  try {
    await assertStrictAmount(
      context,
      intent,
      {
        providerRef: providerStatus.providerRef,
        amountIdr: providerStatus.amountIdr,
      },
      now,
    );
    const settled = await applyConfirmation(
      context,
      intent,
      {
        source: "gateway_status",
        method: intent.method,
        amountIdr: providerStatus.amountIdr,
        providerRef: providerStatus.providerRef,
        at: paidAt,
      },
      { type: "system" },
      now,
      strictOptions(intent),
    );
    await markGatewayReconciled(context, intent, now);
    return { intent: settled, gatewayError: false };
  } catch (error) {
    if (parksFunds(error)) {
      await recordUnsettledGatewayFunds(
        context,
        intent,
        {
          provider: intent.provider,
          providerRef: providerStatus.providerRef,
          source: "gateway_status",
          paidAmountIdr: providerStatus.amountIdr,
          receivedAt: new Date(paidAt),
        },
        now,
      );
      await markGatewayReconciled(context, intent, now);
      return { intent, gatewayError: false };
    }
    throw error;
  }
}

/**
 * SO-885: the provider answered final for an `expired` intent (expired /
 * failed) or its money was reconciled: sets `provider_final_at`, which ends
 * the poll of the code and lets a replacement code or a split change open.
 * Local time never calls this. Touches only an `expired` or `failed` row
 * without proof, so a settled one is left as the lifecycle wrote it and a
 * replay changes nothing.
 */
export async function markGatewayReconciled(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) =>
    markGatewayReconciledInTx(tx, context, intent.id, now),
  );
}

/** The same mark inside the caller's transaction (and lock order). */
async function markGatewayReconciledInTx(
  tx: Tx,
  context: ScopedTenantContext,
  intentId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(paymentIntents)
    .set({ providerFinalAt: now })
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
        inArray(paymentIntents.status, ["expired", "failed"]),
        isNull(paymentIntents.providerFinalAt),
      ),
    );
}

/** Frees the polling lease of `ids`, but only where it is still the one this
 * run took: a run that outlived its lease must not free a newer worker's.
 * Best effort: a failure only means the lease lapses on its own after
 * `GATEWAY_POLL_LEASE_MS`. */
async function releasePollLease(
  context: ScopedTenantContext,
  ids: readonly string[],
  leaseUntil: Date,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    await withTenant(db, context, async (tx) =>
      tx
        .update(paymentIntents)
        .set({ gatewayPollLeaseUntil: null })
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            inArray(paymentIntents.id, [...ids]),
            eq(paymentIntents.gatewayPollLeaseUntil, leaseUntil),
          ),
        ),
    );
  } catch (error) {
    logger.warn({ err: error }, "Payment: releasing the poll lease failed");
  }
}

/**
 * Asks the provider about one intent now and settles it through the same path
 * as the poll (legend-yhia9: the QRIS hold check job, which must not wait for
 * the poll's grace window). A `paid` answer ends in `confirmPayment`; any other
 * answer changes nothing the hold depends on. Returns whether it settled.
 */
export async function settleGatewayIntentNow(
  context: ScopedTenantContext,
  intentId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      ),
  );
  if (!row || row.providerRef === null) return false;
  const outletContext =
    context.outletScope.kind === "tenant"
      ? establishScopedTenantContext(context.tenant, {
          kind: "outlets",
          outletIds: [row.outletId],
        })
      : context;
  const result = isClosedPollable(row)
    ? await syncExpiredIntentPayment(outletContext, row, now)
    : await syncPendingIntentDetailed(outletContext, row, now);
  return (
    row.status !== result.intent.status &&
    (SETTLED_STATUSES as readonly string[]).includes(result.intent.status)
  );
}

/**
 * Polling fallback for a lost webhook (PAY-02/03): asks the gateway about
 * pending intents that have a provider reference and are older than the grace
 * period, through the same path as the customer's status check. Recently
 * expired intents whose gateway code is still payable (superseded by a newer
 * code) are asked too, and so are expired intents closed before their code
 * lapsed that have no definitive answer yet (up to `GATEWAY_POLL_WINDOW_MS`
 * past expiry). A gateway error leaves the intent untouched; the next run
 * retries. Past expiry a code is asked again only after the backoff (half the
 * time since expiry, at most `GATEWAY_POLL_MAX_BACKOFF_MS`). Intents are taken least-recently-polled first and each attempt
 * stamps `gateway_polled_at`, so a few failing intents cannot starve the rest.
 * Live (pending) codes are all processed before any expired code. Each kind
 * has its own time budget, and a provider with three gateway errors in a row
 * (the gateway is down) is skipped per kind, so failing expired codes never
 * starve a live one.
 */
export async function pollPendingGatewayIntents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
): Promise<{ checked: number; settled: number }> {
  const providers = registeredGatewayProviders();
  if (providers.length === 0) return { checked: 0, settled: 0 };
  const cutoff = new Date(now.getTime() - GATEWAY_POLL_GRACE_MS);
  const nowAt = sql`${now.toISOString()}::timestamptz`;
  // Before expiry every run asks; past it, only once the backoff has passed.
  const backoffDue = or(
    isNull(paymentIntents.gatewayPolledAt),
    gt(paymentIntents.expiresAt, now),
    sql`${paymentIntents.gatewayPolledAt} <= ${nowAt} - least((${nowAt} - ${paymentIntents.expiresAt}) / 2, ${`${GATEWAY_POLL_MAX_BACKOFF_MS} milliseconds`}::interval)`,
  );
  // The lease runs on the wall clock, not on the caller's `now` (which the
  // worker took before slower steps and tests move around).
  const leaseNow = new Date();
  const leaseUntil = new Date(leaseNow.getTime() + GATEWAY_POLL_LEASE_MS);
  // Claim atomically: rows another worker holds (a live lease, or a row lock
  // mid-claim) are skipped, so two workers never poll the same intent.
  const pending = await withTenant(db, context, async (tx) => {
    // One window per provider: rows of a provider at its error budget are
    // skipped without a stamp, so a shared window would fill with them and
    // starve the other providers.
    const candidates: Array<{ id: string }> = [];
    // SO-885: live (pending) codes and expired / failed codes still without
    // provider proof get separate quotas, so a backlog of old expired codes (no
    // backfill in 0629) can never delay a live one.
    for (const provider of providers)
      for (const kind of ["pending", "expired"] as const) {
        const rows = await tx
          .select({ id: paymentIntents.id })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, context.tenant.tenantId),
              or(
                isNull(paymentIntents.gatewayPollLeaseUntil),
                lte(paymentIntents.gatewayPollLeaseUntil, leaseNow),
              ),
              // An expired or failed code stays in the poll until the provider
              // answers final, however long ago it lapsed (no window).
              kind === "pending"
                ? and(eq(paymentIntents.status, "pending"), noVaRelease)
                : or(expiredCodeMayStillPay(), failedCodeNotFinal()),
              backoffDue,
              eq(paymentIntents.provider, provider),
              isNotNull(paymentIntents.providerRef),
              or(
                lt(paymentIntents.createdAt, cutoff),
                // legend-yhia9 D-09: a QRIS under an active hold is polled from
                // the start (an edge never gets the webhook; the grace only
                // exists to let a webhook win the race).
                sql`exists (select 1 from pos_qris_holds h
                   where h.tenant_id = ${paymentIntents.tenantId}
                     and h.payment_intent_id = ${paymentIntents.id}
                     and h.state in ('open', 'cancelling'))`,
              ),
            ),
          )
          .orderBy(
            sql`${paymentIntents.gatewayPolledAt} asc nulls first`,
            asc(paymentIntents.createdAt),
          )
          .limit(limit)
          .for("update", { skipLocked: true });
        candidates.push(...rows);
      }
    if (candidates.length === 0) return [];
    const claimed = await tx
      .update(paymentIntents)
      .set({ gatewayPollLeaseUntil: leaseUntil })
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          inArray(
            paymentIntents.id,
            candidates.map((row) => row.id),
          ),
        ),
      )
      .returning();
    // `returning` has no order, and the per-provider windows come back grouped
    // by provider. SO-885: every live (pending) code goes before any expired
    // code; inside each kind, one global least-recently-polled-first order
    // (never polled first, then oldest) so a slow provider that uses up the
    // time budget cannot keep another provider's rows behind its own forever.
    return claimed.sort((a, b) => {
      const ak = a.status === "pending" ? 0 : 1;
      const bk = b.status === "pending" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      const ap = a.gatewayPolledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bp = b.gatewayPolledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (ap !== bp) return ap < bp ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  });
  let checked = 0;
  let settled = 0;
  // Error budget per provider AND per kind: one down gateway never stops
  // another's poll, and failing expired codes never use up the budget of the
  // live (pending) codes of the same provider. Each kind also has its own time
  // budget, started when the kind's first row is reached.
  const consecutiveErrors = new Map<string, number>();
  const kindStartedAt = new Map<string, number>();
  try {
    for (const row of pending) {
      const kind = row.status === "pending" ? "pending" : "expired";
      const startedAt = kindStartedAt.get(kind) ?? Date.now();
      kindStartedAt.set(kind, startedAt);
      if (Date.now() - startedAt >= GATEWAY_POLL_BUDGET_MS) continue;
      const budgetKey = `${row.provider}:${kind}`;
      if (
        (consecutiveErrors.get(budgetKey) ?? 0) >=
        GATEWAY_POLL_MAX_CONSECUTIVE_ERRORS
      )
        continue;
      checked += 1;
      try {
        // Stamp the attempt first so an erroring intent rotates to the back.
        await withTenant(db, context, async (tx) =>
          tx
            .update(paymentIntents)
            .set({ gatewayPolledAt: now })
            .where(
              and(
                eq(paymentIntents.tenantId, context.tenant.tenantId),
                eq(paymentIntents.id, row.id),
              ),
            ),
        );
        // Narrow to the intent's outlet so the gateway reads that outlet's own
        // DOIT credentials when it has them (outlet row wins over tenant row).
        const outletContext =
          context.outletScope.kind === "tenant"
            ? establishScopedTenantContext(context.tenant, {
                kind: "outlets",
                outletIds: [row.outletId],
              })
            : context;
        const result = isClosedPollable(row)
          ? await syncExpiredIntentPayment(outletContext, row, now)
          : await syncPendingIntentDetailed(outletContext, row, now);
        consecutiveErrors.set(
          budgetKey,
          result.gatewayError ? (consecutiveErrors.get(budgetKey) ?? 0) + 1 : 0,
        );
        if (
          row.status !== result.intent.status &&
          (SETTLED_STATUSES as readonly string[]).includes(result.intent.status)
        )
          settled += 1;
      } catch {
        // One intent's failure never blocks the others; the next run retries.
      }
    }
  } finally {
    // Release the claim (also the rows a break left unprocessed) so the next
    // run, or another worker, can take them straight away.
    await releasePollLease(
      context,
      pending.map((row) => row.id),
      leaseUntil,
    );
  }
  return { checked, settled };
}
