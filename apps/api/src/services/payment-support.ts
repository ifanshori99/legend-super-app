// Shared plumbing for the payment services (bead legend-gz3).
//
// - DTO mappers from Drizzle rows to the wire contracts in
//   `@starter/shared/payment` (the API never invents a field).
// - Event append inside the caller's tenant transaction (outbox, WS-00), with
//   the same per-aggregate sequence rule the access service uses.
// - Service-boundary permission checks: the RBAC resolver decides, the service
//   only asks (TEN-03).
// - Payment link tokens: random, handed to the guest once, stored as SHA-256.

import { createHash, randomBytes } from "node:crypto";
import {
  createUlid,
  uuidToUlid,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  customerPaymentIntentSchema,
  paymentIntentSchema,
  type CustomerPaymentIntent,
  type PaymentIntent,
} from "@starter/shared/payment";
import { and, eq, sql } from "drizzle-orm";
import { domainEventOutbox } from "../db/schema";
import type { paymentIntents, paymentLinks } from "../db/schema/payment";
import { appendOutbox } from "./core-outbox";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver";

/** Consumers receive payment events through the cloud sync stream. */
export const EVENT_DESTINATION = "cloud-sync";

export type PaymentLinkRow = typeof paymentLinks.$inferSelect;
export type PaymentIntentRow = typeof paymentIntents.$inferSelect;

export function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

/** Guest credential: 256 random bits, URL-safe, recognisable prefix. */
export function createPaymentLinkToken(): string {
  return `pl_${randomBytes(32).toString("base64url")}`;
}

export function hashPaymentLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whole rupiah still owed on a link (never negative). */
export function outstandingIdr(link: PaymentLinkRow): Idr {
  return Math.max(0, link.totalIdr - link.paidIdr) as Idr;
}

/** The guest-facing intent (contract shape): instructions and flags derived. */
export function toCustomerIntent(row: PaymentIntentRow): CustomerPaymentIntent {
  return customerPaymentIntentSchema.parse({
    id: row.id,
    method: row.method,
    status: row.status,
    amountIdr: row.amountIdr,
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    paidAfterExpiry: row.flags.includes("late_payment"),
    instructions: row.instructions,
  });
}

/** The internal intent record (PRD §6 D), unchanged from the database. */
export function toPaymentIntent(row: PaymentIntentRow): PaymentIntent {
  return paymentIntentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId ? uuidToUlid(row.orderId) : null,
    billSplitId: row.billSplitId,
    reservationId: row.reservationId,
    accessTicketId: row.accessTicketId ? uuidToUlid(row.accessTicketId) : null,
    subscriptionInvoiceId: row.subscriptionInvoiceId,
    method: row.method,
    provider: row.provider,
    amountIdr: row.amountIdr,
    feeIdr: row.feeIdr,
    idempotencyKey: row.idempotencyKey,
    providerRef: row.providerRef,
    status: row.status,
    flags: row.flags,
    edcTransactionId: row.edcTransactionId,
    paidAt: row.paidAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  });
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/**
 * Appends one catalogued payment event in the caller's transaction. Payment
 * events are never emitted before the database change commits (WS-00 outbox).
 */
export async function appendPaymentEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    name:
      | "payment_intent.created"
      | "payment.paid"
      | "payment.funds_unallocated"
      | "payment.refund_requested"
      | "payment.refunded"
      | "payment.provider_refunded"
      | "payment.expired"
      | "payment.failed"
      | "payment_route.updated"
      | "edc_terminal.created"
      | "edc_terminal.updated"
      | "cashier_payment_default.updated";
    aggregateId: string;
    /** The row's outlet (inside the caller's scope); null for tenant config. */
    outletId: string | null;
    actor: { type: "user"; id: string } | { type: "system" };
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const aggregateType = input.name.split(".")[0]!;
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    aggregateType,
    input.aggregateId,
  );
  const event = eventEnvelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: input.name,
    version: 1,
    aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor:
      input.actor.type === "user"
        ? { type: "user", id: input.actor.id }
        : { type: "system" },
    deviceId: null,
    idempotencyKey: `${input.name}:${input.aggregateId}:${sequence}`.slice(
      0,
      100,
    ),
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Service-boundary authorization (TEN-03). The caller's verified user id is
 * required, and the resolver answers from stored assignments, roles and the
 * org tree inside the same transaction. Deny by default.
 */
export async function assertPaymentPermission(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  permission: PermissionCode,
  target: { type: "tenant" } | { type: "outlet"; id: string },
  now: Date,
): Promise<void> {
  const data = await loadTenantAccessInTransaction(tx, context, userId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId,
    ...data,
    mfaVerified: false,
    now,
  });
  if (!snapshot.allows(permission, target))
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action.",
    );
}
