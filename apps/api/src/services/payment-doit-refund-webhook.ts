// DOIT refund webhook parsing and matching (bead legend-0ogy; PAY-04, PAY-06).
//
// The docs list `refund.succeeded` / `refund.failed` but not their `data`, so
// the parser is loose on purpose and every field is optional: what cannot be
// read is simply absent, and an event that names nothing we can match goes the
// "unmatched" way (retried briefly, then ignored). Only the facts below are
// kept, bounded and normalised, so a stored row re-parses to the same facts
// (the worker retry reads the stored payload) and no unknown field is stored.
//
// Pure: no database, no logging.

import { z } from "zod";
import { doitPaymentStatusSchema } from "./payment-doit-wire";

export const DOIT_REFUND_EVENT_TYPES = [
  "refund.succeeded",
  "refund.failed",
] as const;
export type DoitRefundEventType = (typeof DOIT_REFUND_EVENT_TYPES)[number];

export function isDoitRefundEvent(type: string): type is DoitRefundEventType {
  return (DOIT_REFUND_EVENT_TYPES as readonly string[]).includes(type);
}

const REFUND_KEY =
  /^refund:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FAILURE_CODE = /^[a-z_]{1,64}$/;

/** Refund id named by an idempotency key `refund:<uuid>`, or null. */
export function refundIdFromKey(key: string | undefined): string | null {
  const id = key === undefined ? undefined : REFUND_KEY.exec(key)?.[1];
  return id ? id.toLowerCase() : null;
}

export type DoitRefundPaymentFacts = {
  id: string;
  reference: string;
  status: z.infer<typeof doitPaymentStatusSchema>;
  amount: number;
};

/** What a refund event tells us, all optional. */
export type DoitRefundFacts = {
  idempotencyKey?: string;
  refundId?: string;
  /** Refund amount: only from a refund-shaped object, never a payment's. */
  amountIdr?: number;
  failureCode?: string;
  payment?: DoitRefundPaymentFacts;
};

const textSchema = z.string().min(1).max(100);
const amountSchema = z.number().int().nonnegative();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  const parsed = textSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function amount(value: unknown): number | undefined {
  const parsed = amountSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function failureCode(value: unknown): string | undefined {
  return typeof value === "string" && FAILURE_CODE.test(value)
    ? value
    : undefined;
}

function paymentFacts(value: unknown): DoitRefundPaymentFacts | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = text(record.id);
  const reference = z.string().min(1).max(128).safeParse(record.reference);
  const status = doitPaymentStatusSchema.safeParse(record.status);
  const paid = amount(record.amount);
  if (!id || !reference.success || !status.success || paid === undefined)
    return undefined;
  return {
    id,
    reference: reference.data,
    status: status.data,
    amount: paid,
  };
}

/** Facts out of any `data` (loose, never throws). */
export function readDoitRefundFacts(data: unknown): DoitRefundFacts {
  const record = asRecord(data) ?? {};
  const refund = asRecord(record.refund) ?? {};
  const isRefundObject = record.object === "refund";
  // A payment-shaped `data` (has `reference`): its `amount` is the payment's.
  const paymentShaped = typeof record.reference === "string";
  const payment =
    paymentFacts(record.payment) ??
    (paymentShaped ? paymentFacts(record) : undefined);
  const facts: DoitRefundFacts = {};
  const key = text(record.idempotency_key) ?? text(refund.idempotency_key);
  if (key) facts.idempotencyKey = key;
  const refundId = text(refund.id) ?? (isRefundObject ? text(record.id) : null);
  if (refundId) facts.refundId = refundId;
  const refundAmount =
    amount(refund.amount) ??
    (isRefundObject || !paymentShaped ? amount(record.amount) : undefined);
  if (refundAmount !== undefined) facts.amountIdr = refundAmount;
  const code =
    failureCode(refund.failure_code) ?? failureCode(record.failure_code);
  if (code) facts.failureCode = code;
  if (payment) facts.payment = payment;
  return facts;
}

export const doitRefundWebhookEnvelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(60),
  created_at: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp"),
  data: z.unknown(),
});

/**
 * Refund event as stored: envelope plus the normalised, bounded `data`. The
 * canonical `data` re-parses to the same facts, so a retry from the stored
 * payload behaves like the first delivery.
 */
export const doitRefundWebhookEventSchema =
  doitRefundWebhookEnvelopeSchema.transform((event) => {
    const facts = readDoitRefundFacts(event.data);
    const refund: Record<string, unknown> = {};
    if (facts.refundId) refund.id = facts.refundId;
    if (facts.amountIdr !== undefined) refund.amount = facts.amountIdr;
    if (facts.failureCode) refund.failure_code = facts.failureCode;
    const data: Record<string, unknown> = { refund };
    if (facts.idempotencyKey) data.idempotency_key = facts.idempotencyKey;
    if (facts.payment) data.payment = facts.payment;
    return {
      id: event.id,
      type: event.type,
      created_at: event.created_at,
      data,
    };
  });
export type DoitRefundWebhookEvent = z.infer<
  typeof doitRefundWebhookEventSchema
>;

export type DoitRefundMatch =
  | { kind: "key"; refundId: string }
  | { kind: "refund_id"; providerRef: string }
  | { kind: "payment_object"; payment: DoitRefundPaymentFacts }
  | { kind: "none" };

/**
 * First matching path, in order: (a) idempotency key `refund:<uuid>`, (b)
 * provider refund id, (c) a `refund.succeeded` whose payment object is
 * `refunded` (settled against the single approved refund of that payment by
 * the caller). `refund.failed` never takes (c).
 */
export function matchDoitRefundEvent(
  type: string,
  facts: DoitRefundFacts,
): DoitRefundMatch {
  const keyed = refundIdFromKey(facts.idempotencyKey);
  if (keyed) return { kind: "key", refundId: keyed };
  if (facts.refundId) return { kind: "refund_id", providerRef: facts.refundId };
  if (
    type === "refund.succeeded" &&
    facts.payment &&
    facts.payment.status === "refunded"
  )
    return { kind: "payment_object", payment: facts.payment };
  return { kind: "none" };
}

export type RefundCandidateRow = {
  id: string;
  status: string;
  amountIdr: number;
  /** A fund refund pays back evidence, not the intent's own payment. */
  unallocatedFundId: string | null;
};

/**
 * Path (c) decision over every refund of the payment's intent: exactly one
 * `approved` refund, its amount equal to the payment amount, and no other
 * refund that is not `failed`, and not a refund of an unallocated fund (its
 * money may come from another payment than the intent's own). Anything else is no match (never a guess).
 */
export function pickRefundCandidate(
  refunds: readonly RefundCandidateRow[],
  paymentAmountIdr: number,
): RefundCandidateRow | null {
  const live = refunds.filter((refund) => refund.status !== "failed");
  if (live.length !== 1) return null;
  const [only] = live;
  return only!.status === "approved" &&
    only!.unallocatedFundId === null &&
    only!.amountIdr === paymentAmountIdr
    ? only!
    : null;
}
