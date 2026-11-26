// Fixtures for the QRIS hold acceptance tests (design legend-yhia9, qris.md
// §3 D-01..D-09, §7 case table, §8). Not a test file.
//
// Everything here is written from the design and the public contract, not from
// the hold implementation. Pieces that do not exist yet (table
// `pos_qris_holds`, the hold check job, the `qris/cancel` route) are reached by
// raw SQL, HTTP or a run-time import so a missing feature fails as a clear
// assertion inside the test that needs it, never as an import crash.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  CoreError,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import type { PaymentChannel } from "@starter/shared/payment";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type GatewayPaymentStatus,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  applyGatewayFailure,
  confirmPayment,
} from "../services/payment.service.ts";
import { handlePosPaymentPaid } from "../services/pos-order-payment.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { owner } from "./floor-test-helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import {
  captainPaymentFixture,
  resetCaptainPaymentPorts,
} from "./pos-captain-payment-test-helpers.ts";

// Q92 decided by the founder (13 Nov 2026): QR lifetime at the cashier is
// 5 minutes (wait after cancel <= ~6 min). Tests derive times from the
// intent's own `expires_at`; this only sizes clock jumps and the lifetime check.
export const QR_LIFETIME_MIN = 5;
/** D-03: a hold closes only at or after `expires_at` + 60 s (clock skew). */
export const HOLD_CLOSE_MARGIN_S = 60;
// Q93 decided by the founder (13 Nov 2026): a manager may release a hold
// through pos-overrides PIN approval, only when now >= expires_at + 30 min.
export const HOLD_RELEASE_AFTER_MIN = 30;

// ------------------------------------------------------------ scripted gateway

/**
 * What the provider says when asked about one intent.
 * - `{ rawStatus }`: Duitku style code. `"00"` paid (pays the intent amount
 *   unless `amountIdr` is given), `"01"` still pending, `"02"` failed/expired.
 *   The port status is mapped like the adapter does (00 paid, 01 pending,
 *   02 expired) and `rawStatus` is carried on the answer (D-03).
 * - `{ status }`: a mapped status WITHOUT a raw code (what the port returns
 *   today, and what a DOIT `expired`/`failed` looks like). For a Duitku
 *   intent this must never close a hold (QH-24).
 * - `{ error }`: the status read throws (`timeout`, or a `5xx`).
 * - `{ otherReference: true }`: the provider answers `02` but about ANOTHER
 *   provider reference; it must never close this intent's hold (QH-10).
 */
export type ProviderAnswer =
  | {
      rawStatus: "00" | "01" | "02";
      amountIdr?: number;
      paidAt?: string;
    }
  | {
      status: "pending" | "paid" | "expired" | "failed";
      amountIdr?: number;
    }
  | { error: "timeout" | "5xx" }
  | { otherReference: true };

export type ScriptedStatus = GatewayPaymentStatus & {
  /** The provider's own code; new on the port (D-03). */
  readonly rawStatus?: string;
};

export class ScriptedGateway implements PaymentGatewayPort {
  readonly provider: string;
  /** Every createIntent request, in order. */
  readonly requests: GatewayIntentRequest[] = [];
  /** Every getStatus call, in order. */
  readonly statusReads: { intentId: string | null; providerRef: string }[] = [];
  private readonly sticky = new Map<string, ProviderAnswer>();
  private readonly queued = new Map<string, ProviderAnswer[]>();
  private readonly byProviderRef = new Map<string, string>();
  private failCreates = 0;

  constructor(provider = "doit") {
    this.provider = provider;
  }

  /** The next createIntent throws; no tender, no hold, QR never shown (QH-16). */
  failNextCreate(times = 1) {
    this.failCreates += times;
  }
  /** Answer used for every status read of the intent (until replaced). */
  script(intentId: string, answer: ProviderAnswer) {
    this.sticky.set(intentId, answer);
  }
  /** One-shot answers, consumed before the sticky one. */
  queue(intentId: string, ...answers: ProviderAnswer[]) {
    this.queued.set(intentId, [
      ...(this.queued.get(intentId) ?? []),
      ...answers,
    ]);
  }
  readsOf(intentId: string) {
    return this.statusReads.filter((read) => read.intentId === intentId);
  }
  amountOf(intentId: string) {
    return this.requests.find((r) => r.intentId === intentId)?.amountIdr ?? 0;
  }

  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new CoreError(
        "SERVICE_UNAVAILABLE",
        "Gateway QRIS tidak tersedia (scripted).",
      );
    }
    this.requests.push(input);
    const providerRef = `HOLD-${randomUUID()}`;
    this.byProviderRef.set(providerRef, input.intentId);
    return {
      providerRef,
      instructions: {
        method: "qris" as const,
        qrPayload: "00020101021226HOLDQRIS",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: {
    providerRef: string;
    intentId?: string;
  }): Promise<ScriptedStatus> {
    const intentId =
      input.intentId ?? this.byProviderRef.get(input.providerRef) ?? null;
    this.statusReads.push({ intentId, providerRef: input.providerRef });
    const next = intentId ? this.queued.get(intentId)?.shift() : undefined;
    const answer: ProviderAnswer = next ??
      (intentId ? this.sticky.get(intentId) : undefined) ?? {
        rawStatus: "01",
      };
    if ("error" in answer) {
      throw new Error(
        answer.error === "timeout"
          ? "gateway timeout (scripted)"
          : "gateway 503 (scripted)",
      );
    }
    if ("otherReference" in answer) {
      return {
        status: "expired",
        rawStatus: "02",
        providerRef: `OTHER-${randomUUID()}`,
        amountIdr: null,
      };
    }
    if ("rawStatus" in answer) {
      const mapped = (
        { "00": "paid", "01": "pending", "02": "expired" } as const
      )[answer.rawStatus];
      return {
        status: mapped,
        rawStatus: answer.rawStatus,
        providerRef: input.providerRef,
        amountIdr:
          mapped === "paid"
            ? (answer.amountIdr ?? this.amountOf(intentId ?? ""))
            : null,
        ...(answer.paidAt ? { paidAt: answer.paidAt } : {}),
      };
    }
    return {
      status: answer.status,
      providerRef: input.providerRef,
      amountIdr:
        answer.status === "paid"
          ? (answer.amountIdr ?? this.amountOf(intentId ?? ""))
          : null,
    };
  }
  async channels(): Promise<PaymentChannel[]> {
    return [];
  }
}

/**
 * The captain payment fixture with a scripted gateway installed AFTER it (the
 * fixture installs its own unscripted one). `fx.gateway` is the scripted one,
 * so `fx.gateway.requests` keeps working as in the MONEY tests.
 * `provider`: `"doit"` (default) or `"duitku"`; the intent's provider is the
 * port's provider (D-03), so this picks which closure evidence rule applies.
 */
export async function holdFixture(
  label: string,
  options: { provider?: string } = {},
) {
  const base = await captainPaymentFixture(label);
  const gateway = new ScriptedGateway(options.provider ?? "doit");
  setPaymentGateway(gateway);
  return { ...base, gateway };
}
export type HoldFixture = Awaited<ReturnType<typeof holdFixture>>;

/** afterAll of every hold test file. */
export function resetHoldPorts() {
  setQrOrderDepositCreditLookup(null);
  resetCaptainPaymentPorts();
}

export function scriptProviderStatus(
  fx: HoldFixture,
  intentId: string,
  answer: ProviderAnswer,
) {
  fx.gateway.script(intentId, answer);
}

// ----------------------------------------------------------------------- clock

/** Controllable clock for `expires_at` tests. No fake timers: pass `now()` to
 * confirmPayment, the poll, the hold check job and the outbox consumers. */
export function fixedClock(start: Date | string | number = new Date()) {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
      return new Date(current);
    },
    set(to: Date | string | number) {
      current = new Date(to).getTime();
      return new Date(current);
    },
  };
}
export type FixedClock = ReturnType<typeof fixedClock>;

// ------------------------------------------------------------ orders and QRIS

type SubmittedOrder = {
  id: string;
  status: string;
  totalIdr: number;
  depositAppliedIdr: number;
};

/** A submitted POS bill with `depositIdr` already attached by the submit
 * (the only public way to get a DP onto a bill). Total is the meal price
 * plus tax from the cashier fixture. */
export async function newSubmittedOrder(
  fx: HoldFixture,
  depositIdr = 0,
): Promise<SubmittedOrder> {
  setQrOrderDepositCreditLookup(async () => depositIdr);
  try {
    const guest = await fx.newGuest();
    const draft = await fx.createDraft(guest.sessionId);
    expect(draft.depositAppliedIdr).toBe(0);
    const submitted = await fx.submit(draft.id);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.depositAppliedIdr).toBe(depositIdr);
    return submitted.body.data as SubmittedOrder;
  } finally {
    setQrOrderDepositCreditLookup(null);
  }
}

async function orderStatus(fx: HoldFixture, orderId: string) {
  const current = await fx.get(`${fx.base}/${orderId}`);
  expect(current.status, JSON.stringify(current.body)).toBe(200);
  return current.body.data.status as string;
}

/** POST a QRIS tender and return the raw response (for 409 / 422 cases). */
export async function requestQris(fx: HoldFixture, orderId: string) {
  return fx.tender(orderId, await orderStatus(fx, orderId), "qris");
}

/** Issue the QR (201 expected) and read back what the intent now holds. */
export async function issueQris(fx: HoldFixture, orderId: string) {
  const opened = await requestQris(fx, orderId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const tender = opened.body.data.tender as {
    id: string;
    amountIdr: number;
    paymentIntentId: string;
  };
  const { rows } = await owner.query<{
    expires_at: Date;
    provider_ref: string | null;
    provider: string;
  }>(
    `SELECT expires_at, provider_ref, provider FROM payment_intents
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, tender.paymentIntentId],
  );
  return {
    tenderId: tender.id,
    intentId: tender.paymentIntentId,
    amountIdr: tender.amountIdr,
    expiresAt: rows[0]!.expires_at,
    providerRef: rows[0]!.provider_ref,
    provider: rows[0]!.provider,
    response: opened,
  };
}
export type IssuedQris = Awaited<ReturnType<typeof issueQris>>;

export type RawWrite =
  { ok: true } | { ok: false; message: string; code: string | null };

/** Raw `UPDATE orders SET deposit_applied_idr` as the RLS-scoped cashier role
 * (no API attaches a DP to a submitted bill). Returns the outcome instead of
 * throwing so a test can assert the refusal (`QRIS_HOLD_ACTIVE`, QH-03/QH-20)
 * and see a clear "ok: true" failure while the freeze does not exist. */
export async function rawSetDeposit(
  fx: HoldFixture,
  orderId: string,
  dpIdr: number,
): Promise<RawWrite> {
  return rawWrite(
    fx,
    "UPDATE orders SET deposit_applied_idr=$3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, ulidToUuid(orderId), dpIdr],
  );
}

/** Any raw statement, same outcome shape as `rawSetDeposit`. */
export async function rawWrite(
  fx: HoldFixture,
  text: string,
  params: unknown[],
): Promise<RawWrite> {
  try {
    await asCashierTenant(fx.tenant.tenantId, (client) =>
      client.query(text, params),
    );
    return { ok: true };
  } catch (error) {
    const e = error as { message?: string; code?: string };
    return {
      ok: false,
      message: e.message ?? String(error),
      code: e.code ?? null,
    };
  }
}

/** Attach a DP to a bill that has NO active hold (e.g. after closure, QH-08).
 * Throws when the write is refused. For the refusal path use `rawSetDeposit`. */
export async function attachDeposit(
  fx: HoldFixture,
  orderId: string,
  dpIdr: number,
) {
  const result = await rawSetDeposit(fx, orderId, dpIdr);
  if (!result.ok) throw new Error(`attachDeposit refused: ${result.message}`);
}

// --------------------------------------------------------------- notices

async function outboxEvents(fx: HoldFixture, name: string, intentId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'=$2 AND event->'payload'->>'intentId'=$3
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

/**
 * A verified paid notice (webhook or poll evidence) for `intentId`:
 * `confirmPayment`, then the `payment.paid` outbox events go to
 * `handlePosPaymentPaid`. Each event is delivered `deliveries` times (default 2,
 * as the MONEY tests: a consumer replay must never capture twice).
 * `providerRef` is the provider's transaction id; pass the same one twice for a
 * duplicate webhook (QH-12).
 */
export async function payNotice(
  fx: HoldFixture,
  intentId: string,
  amountIdr: number,
  now: Date = new Date(),
  providerRef: string = `HOLD-PAY-${randomUUID()}`,
  options: { deliveries?: number; method?: "qris" | "va" | "ewallet" } = {},
) {
  const confirmed = await confirmPayment(
    fx.context,
    intentId,
    {
      source: "verified_webhook",
      method: options.method ?? "qris",
      amountIdr,
      providerRef,
      at: now.toISOString(),
    },
    { type: "system" },
    now,
  );
  const events = await outboxEvents(fx, "payment.paid", intentId);
  for (const event of events)
    for (let i = 0; i < (options.deliveries ?? 2); i += 1)
      await handlePosPaymentPaid(fx.context, event);
  return { confirmed, providerRef, events: events.length };
}

/**
 * The local `payment.expired` for `intentId` (what the existing poll fires on
 * the local clock): expire the intent, then deliver the outbox event through
 * the order-payment consumer inside a tenant transaction, as the worker does.
 * It must change nothing while the hold is active (D-04, QH-23).
 */
export async function expireNotice(
  fx: HoldFixture,
  intentId: string,
  now: Date = new Date(),
) {
  await applyGatewayFailure(fx.context, intentId, "expired", now);
  const events = await outboxEvents(fx, "payment.expired", intentId);
  const routes: unknown[] = [];
  for (const event of events)
    routes.push(
      await withTenant(db, fx.context as ScopedTenantContext, (tx) =>
        deliverOrderPaymentEvent(fx.context, event, tx, now),
      ),
    );
  return { events: events.length, routes };
}

// ------------------------------------------------------------ hold reading

export type HoldRow = {
  id: string;
  orderId: string;
  tenderId: string;
  paymentIntentId: string;
  state: string;
  amountIdr: number;
  basisTotalIdr: number | null;
  basisDepositIdr: number | null;
  basisCapturedIdr: number | null;
  backfilled: boolean;
  openedAt: Date;
  cancelRequestedAt: Date | null;
  cancelRequestedBy: string | null;
  lastCheckedAt: Date | null;
  checkAttempts: number;
  nextCheckAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  closeEvidence: Record<string, unknown> | null;
};

const HOLD_SELECT = `SELECT id::text AS id, order_id::text AS order_id,
  tender_id::text AS tender_id, payment_intent_id::text AS payment_intent_id,
  state, amount_idr::int AS amount_idr,
  basis_total_idr::int AS basis_total_idr, basis_deposit_idr::int AS basis_deposit_idr,
  basis_captured_idr::int AS basis_captured_idr, backfilled, opened_at,
  cancel_requested_at, cancel_requested_by, last_checked_at,
  check_attempts::int AS check_attempts, next_check_at, closed_at,
  close_reason, close_evidence FROM pos_qris_holds
  WHERE tenant_id=$1 AND order_id=$2 ORDER BY opened_at, id`;

async function holdsOf(fx: HoldFixture, orderId: string): Promise<HoldRow[]> {
  try {
    const { rows } = await owner.query(HOLD_SELECT, [
      fx.tenant.tenantId,
      ulidToUuid(orderId),
    ]);
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      tenderId: r.tender_id,
      paymentIntentId: r.payment_intent_id,
      state: r.state,
      amountIdr: r.amount_idr,
      basisTotalIdr: r.basis_total_idr,
      basisDepositIdr: r.basis_deposit_idr,
      basisCapturedIdr: r.basis_captured_idr,
      backfilled: r.backfilled,
      openedAt: r.opened_at,
      cancelRequestedAt: r.cancel_requested_at,
      cancelRequestedBy: r.cancel_requested_by,
      lastCheckedAt: r.last_checked_at,
      checkAttempts: r.check_attempts,
      nextCheckAt: r.next_check_at,
      closedAt: r.closed_at,
      closeReason: r.close_reason,
      closeEvidence: r.close_evidence,
    }));
  } catch (error) {
    if ((error as { code?: string }).code === "42P01")
      throw new Error(
        "Table pos_qris_holds does not exist: migration 0368 (QRIS hold) is not applied.",
      );
    throw error;
  }
}

/** Every hold of the bill, oldest first (holds are never deleted). */
export const readHolds = holdsOf;

/** The newest hold of the bill, or null when none exists. Throws a clear
 * message when the `pos_qris_holds` table is missing. */
export async function readHold(
  fx: HoldFixture,
  orderId: string,
): Promise<HoldRow | null> {
  const holds = await holdsOf(fx, orderId);
  return holds.at(-1) ?? null;
}

/** `payment_unallocated_funds` rows of the tenant (money parked, QH-13..15),
 * optionally of one intent. Amounts in whole Rupiah. */
export async function unallocatedFunds(fx: HoldFixture, intentId?: string) {
  const { rows } = await owner.query<{
    id: string;
    payment_intent_id: string;
    amount_idr: number;
    reason: string;
    resolution: string | null;
  }>(
    `SELECT id::text AS id, payment_intent_id::text AS payment_intent_id,
            amount_idr::int AS amount_idr, reason, resolution
       FROM payment_unallocated_funds
      WHERE tenant_id=$1 AND ($2::uuid IS NULL OR payment_intent_id=$2::uuid)
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    paymentIntentId: r.payment_intent_id,
    amountIdr: r.amount_idr,
    reason: r.reason,
    resolution: r.resolution,
  }));
}

/** Pending/any `payment_refunds` of an intent, whole Rupiah. */
export async function refundsOfIntent(fx: HoldFixture, intentId: string) {
  const { rows } = await owner.query<{
    amount: number;
    status: string;
    requested_by: string;
  }>(
    `SELECT amount_idr::int AS amount, status, requested_by
       FROM payment_refunds WHERE tenant_id=$1 AND payment_intent_id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows.map((r) => ({
    amountIdr: r.amount,
    status: r.status,
    requestedBy: r.requested_by,
  }));
}

/** Captured tender sum of the bill, whole Rupiah. */
export async function capturedIdr(fx: HoldFixture, orderId: string) {
  const { rows } = await owner.query<{ amount: number }>(
    `SELECT coalesce(sum(amount_idr),0)::int AS amount FROM pos_order_tenders
      WHERE tenant_id=$1 AND order_id=$2 AND status='captured'`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.amount;
}

/** Status of every tender of the bill, oldest first. */
export async function tenderStatuses(fx: HoldFixture, orderId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    method: string;
    amount: number;
  }>(
    `SELECT id::text AS id, status, method, amount_idr::int AS amount
       FROM pos_order_tenders WHERE tenant_id=$1 AND order_id=$2
      ORDER BY requested_at, id`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows;
}

/** Bill money as stored: T, D (whole Rupiah) and status. */
export async function readBill(fx: HoldFixture, orderId: string) {
  const { rows } = await owner.query<{
    total: number;
    deposit: number;
    status: string;
  }>(
    `SELECT total_idr::int AS total, deposit_applied_idr::int AS deposit, status
       FROM orders WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return {
    totalIdr: rows[0]!.total,
    depositIdr: rows[0]!.deposit,
    status: rows[0]!.status,
  };
}

// ---------------------------------------------------------- routes and jobs

/** `POST .../orders/:orderId/qris/cancel` (D-04). Same key twice = idempotent. */
export function postCancel(
  fx: HoldFixture,
  orderId: string,
  idempotencyKey: string = randomUUID(),
) {
  return fx.post(`${fx.base}/${orderId}/qris/cancel`, { idempotencyKey });
}

/** Manager approval from the pos-overrides flow (`createPosOverride`, status
 * approved), as the other POS routes take it: `{ approvedBy, overrideId }`. */
export type ManagerApproval = { approvedBy: string; overrideId: string };

/**
 * `POST .../orders/:orderId/qris/release` (Q93): manager release of a stuck
 * hold. Allowed only when `now >= expires_at + HOLD_RELEASE_AFTER_MIN`; closes
 * the hold with `close_reason = 'force_released'`, audited. The server judges
 * time with its own clock, so a test either backdates the intent's
 * `expires_at` in SQL or expects 409 for the too-early case.
 * Assumption: body is `{ approvedBy, overrideId, idempotencyKey }`.
 */
export function postRelease(
  fx: HoldFixture,
  orderId: string,
  managerApproval: ManagerApproval,
  idempotencyKey: string = randomUUID(),
) {
  return fx.post(`${fx.base}/${orderId}/qris/release`, {
    ...managerApproval,
    idempotencyKey,
  });
}

/** `GET .../orders/:orderId/qris` (hold state for the cashier). */
export function getQris(fx: HoldFixture, orderId: string) {
  return fx.get(`${fx.base}/${orderId}/qris`);
}

/**
 * Turns a missing module into a clear assertion error. `specifier` is
 * relative to this file; resolved at run time (`@vite-ignore`) so a module
 * that does not exist yet never crashes the test file.
 */
export async function tryImport<T = Record<string, unknown>>(
  specifier: string,
  feature: string,
): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /Cannot find module|Failed to (load|resolve)|does not exist|ERR_MODULE_NOT_FOUND/i.test(
        message,
      )
    )
      throw new Error(
        `${feature} is missing (module ${specifier} not found): ${message}`,
      );
    throw error;
  }
}

/**
 * Assumption (design names the file, not the export): the hold check job
 * `worker/pos-qris-hold-check.job.ts` exports
 * `runPosQrisHoldCheckJob(context, now?, options?: { force?: boolean })`,
 * the same shape as `runPaymentGatewayPollJob`. Fails with a clear message
 * while the module or export is missing.
 */
export async function runHoldCheck(fx: HoldFixture, now: Date = new Date()) {
  const job = await tryImport<{
    runPosQrisHoldCheckJob?: (
      context: ScopedTenantContext,
      now?: Date,
      options?: { force?: boolean },
    ) => Promise<unknown>;
  }>("../worker/pos-qris-hold-check.job.ts", "QRIS hold check job");
  if (typeof job.runPosQrisHoldCheckJob !== "function")
    throw new Error(
      "QRIS hold check job is missing: worker/pos-qris-hold-check.job.ts must export runPosQrisHoldCheckJob(context, now, { force })",
    );
  return job.runPosQrisHoldCheckJob(fx.context, now, { force: true });
}

// -------------------------------------------------------------- invariants

/**
 * I1, I2 and I6 of the design (§7) in explicit Rupiah, read straight from SQL:
 * - I1 `C + D <= T`; `C + D = T` when the bill is `completed`.
 * - I2 at most one hold `open`/`cancelling` for the bill.
 * - I6 a provider payment is captured at most once: no intent has two captured
 *   tenders, and the captured amount of an intent never exceeds the evidence
 *   (provider money) recorded for it.
 * `holds: false` skips I2 for tests that must pass before the table exists.
 * Returns the numbers so a test can also assert them.
 */
export async function assertInvariants(
  fx: HoldFixture,
  orderId: string,
  options: { holds?: boolean } = {},
) {
  const bill = await readBill(fx, orderId);
  const captured = await capturedIdr(fx, orderId);
  expect(
    captured + bill.depositIdr,
    `I1: captured ${captured} + DP ${bill.depositIdr} must not exceed total ${bill.totalIdr}`,
  ).toBeLessThanOrEqual(bill.totalIdr);
  if (bill.status === "completed")
    expect(
      captured + bill.depositIdr,
      `I1: completed bill must be fully paid (total ${bill.totalIdr})`,
    ).toBe(bill.totalIdr);

  let activeHolds = 0;
  if (options.holds !== false) {
    const holds = await holdsOf(fx, orderId);
    activeHolds = holds.filter(
      (h) => h.state === "open" || h.state === "cancelling",
    ).length;
    expect(
      activeHolds,
      "I2: at most one active hold per bill",
    ).toBeLessThanOrEqual(1);
  }

  const perIntent = await owner.query<{
    payment_intent_id: string;
    captured_count: number;
    captured_idr: number;
    evidence_idr: number;
  }>(
    `SELECT t.payment_intent_id::text AS payment_intent_id,
            count(*) FILTER (WHERE t.status='captured')::int AS captured_count,
            coalesce(sum(t.amount_idr) FILTER (WHERE t.status='captured'),0)::int AS captured_idr,
            (SELECT coalesce(sum(e.amount_idr),0)::int FROM payment_evidence e
              WHERE e.tenant_id=t.tenant_id AND e.payment_intent_id=t.payment_intent_id) AS evidence_idr
       FROM pos_order_tenders t
      WHERE t.tenant_id=$1 AND t.order_id=$2 AND t.payment_intent_id IS NOT NULL
      GROUP BY t.tenant_id, t.payment_intent_id`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  for (const row of perIntent.rows) {
    expect(
      row.captured_count,
      `I6: intent ${row.payment_intent_id} captured more than once`,
    ).toBeLessThanOrEqual(1);
    expect(
      row.captured_idr,
      `I6: captured ${row.captured_idr} exceeds provider evidence ${row.evidence_idr}`,
    ).toBeLessThanOrEqual(row.evidence_idr);
  }
  return {
    totalIdr: bill.totalIdr,
    depositIdr: bill.depositIdr,
    capturedIdr: captured,
    activeHolds,
  };
}
