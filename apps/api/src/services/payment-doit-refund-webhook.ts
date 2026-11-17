// DOIT refund webhook parsing and matching (bead legend-0ogy; PAY-04, PAY-06).
//
// The docs list `refund.succeeded` / `refund.failed` but not their `data`, so
// the parser is loose on purpose and every field is optional: what cannot be
// read is simply absent, and an event that names nothing we can match goes the
// "unmatched" way (retried briefly, then ignored). Only the facts below are
// kept, bounded and normalised, so a stored row re-parses to the same facts
// (the worker retry reads the stored payload) and no unknown field is stored.
//
// Seen in the DOIT sandbox (legend-0yd1, 9 Nov 2026): `refund.succeeded` has a
// flat `data` `{ amount, refund_id, payment_id }`, no refund object, no
// idempotency key and no payment object.
//
// Pure: no database, no logging.

import { z } from "zod";
import {
  doitPaymentStatusSchema,
  parseDoitIntegerString,
} from "./payment-doit-wire";

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
  /** Provider payment id named by a flat `payment_id` (no payment object). */
  paymentId?: string;
  /** Intent reference carried by a refund object (legend-r7g2): checked
   * against the refund's intent like a payment object's `reference`. */
  reference?: string;
  /** Status the refund object carries (`succeeded`, `failed`, `pending`...),
   * when it carries one (legend-9s33i: only a succeeded refund is held). */
  refundStatus?: string;
  /** legend-2ol8g: facts the event carries but we could not read (or, on an
   * event matched by key or refund id, that it must carry and does not). Sorted, unique. The
   * caller never settles on such an event. */
  invalid?: DoitRefundInvalidFact[];
};

export const DOIT_REFUND_INVALID_FACTS = ["amount", "payment_id"] as const;
export type DoitRefundInvalidFact = (typeof DOIT_REFUND_INVALID_FACTS)[number];

const textSchema = z.string().min(1).max(100);
const referenceSchema = z.string().min(1).max(128);
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

/** An integer amount, or a canonical integer string ("4000") as DOIT sends on
 * a replay; any other string is dropped. */
function amount(value: unknown): number | undefined {
  if (typeof value === "string") return parseDoitIntegerString(value);
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
  const reference = referenceSchema.safeParse(record.reference);
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
  // legend-r7g2 (Codex 117 Run B): a refund object that also carries a
  // `reference` stays a refund object; its `id` is the refund's, never the
  // payment's (an explicit `payment` record is still read).
  const paymentShaped = !isRefundObject && typeof record.reference === "string";
  const payment =
    paymentFacts(record.payment) ??
    (paymentShaped ? paymentFacts(record) : undefined);
  const facts: DoitRefundFacts = {};
  const key = text(record.idempotency_key) ?? text(refund.idempotency_key);
  if (key) facts.idempotencyKey = key;
  const refundId =
    text(refund.id) ??
    (isRefundObject ? text(record.id) : undefined) ??
    (paymentShaped ? undefined : text(record.refund_id));
  if (refundId) facts.refundId = refundId;
  // legend-2ol8g: the one raw field the amount is read from; present but
  // unreadable (`"3999.0"`, null, -1) is marked invalid, never silently dropped.
  const rawAmount =
    refund.amount !== undefined
      ? refund.amount
      : isRefundObject || !paymentShaped
        ? record.amount
        : undefined;
  const refundAmount = amount(rawAmount);
  if (refundAmount !== undefined) facts.amountIdr = refundAmount;
  const code =
    failureCode(refund.failure_code) ?? failureCode(record.failure_code);
  if (code) facts.failureCode = code;
  if (payment) facts.payment = payment;
  // legend-2ol8g: the provider payment id may sit flat (`data.payment_id`) or
  // in the refund object (`refund.payment_id`). Same rules for both: present
  // but unreadable is invalid; both present and different is invalid; else it
  // is the one readable id.
  const flatPaymentId = paymentShaped ? undefined : text(record.payment_id);
  const refundPaymentId = text(refund.payment_id);
  const flatPaymentIdBad =
    !paymentShaped && "payment_id" in record && !flatPaymentId;
  const refundPaymentIdBad = "payment_id" in refund && !refundPaymentId;
  const paymentIdConflict =
    flatPaymentId !== undefined &&
    refundPaymentId !== undefined &&
    flatPaymentId !== refundPaymentId;
  const paymentId =
    flatPaymentIdBad || refundPaymentIdBad || paymentIdConflict
      ? undefined
      : (flatPaymentId ?? refundPaymentId);
  if (paymentId) facts.paymentId = paymentId;
  const invalid = new Set<DoitRefundInvalidFact>();
  if (rawAmount !== undefined && refundAmount === undefined)
    invalid.add("amount");
  if (flatPaymentIdBad || refundPaymentIdBad || paymentIdConflict)
    invalid.add("payment_id");
  // A payment object (or payment-shaped data) we cannot read is a payment id
  // we cannot trust.
  if (!payment && (record.payment !== undefined || paymentShaped))
    invalid.add("payment_id");
  // An event that would match by idempotency key or provider refund id (flat
  // sandbox shape, refund object, keyed) must carry both a refund amount and a
  // payment id (flat/refund-level, or the payment object's): a missing one is
  // as bad as an unreadable one. Pure payment-object events (no key, no refund
  // id) are unchanged.
  const matchesByKeyOrRefundId = !!facts.idempotencyKey || !!facts.refundId;
  if (matchesByKeyOrRefundId && refundAmount === undefined)
    invalid.add("amount");
  if (matchesByKeyOrRefundId && !paymentId && !payment)
    invalid.add("payment_id");
  // A stored event keeps its marker in `data.invalid` (see the schema below).
  if (Array.isArray(record.invalid))
    for (const known of DOIT_REFUND_INVALID_FACTS)
      if (record.invalid.includes(known)) invalid.add(known);
  if (invalid.size > 0)
    facts.invalid = DOIT_REFUND_INVALID_FACTS.filter((fact) =>
      invalid.has(fact),
    );
  const reference = referenceSchema.safeParse(
    refund.reference ?? (isRefundObject ? record.reference : undefined),
  );
  if (reference.success) facts.reference = reference.data;
  const refundStatus =
    text(refund.status) ?? (isRefundObject ? text(record.status) : undefined);
  if (refundStatus) facts.refundStatus = refundStatus;
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
    if (facts.reference) refund.reference = facts.reference;
    if (facts.refundStatus) refund.status = facts.refundStatus;
    const data: Record<string, unknown> = { refund };
    if (facts.idempotencyKey) data.idempotency_key = facts.idempotencyKey;
    if (facts.payment) data.payment = facts.payment;
    if (facts.paymentId) data.payment_id = facts.paymentId;
    if (facts.invalid) data.invalid = facts.invalid;
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

/**
 * legend-30hfs: a `refund.succeeded` no refund of ours matches may be a refund
 * the provider made on its own (the money went back to the payer). It can be
 * recorded only when it names its refund id, its payment id (flat, refund-level
 * or the payment object's, never two different ones) and a positive amount,
 * and none of its facts is unreadable. Anything less is null (stays ignored).
 */
export function readProviderInitiatedRefund(
  type: string,
  facts: DoitRefundFacts,
): { refundId: string; paymentId: string; amountIdr: number } | null {
  if (type !== "refund.succeeded" || facts.invalid) return null;
  const { refundId, amountIdr } = facts;
  if (!refundId || amountIdr === undefined || amountIdr <= 0) return null;
  if (
    facts.payment &&
    facts.paymentId !== undefined &&
    facts.payment.id !== facts.paymentId
  )
    return null;
  const paymentId = facts.paymentId ?? facts.payment?.id;
  return paymentId ? { refundId, paymentId, amountIdr } : null;
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
