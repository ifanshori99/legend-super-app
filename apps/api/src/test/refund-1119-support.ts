// Shared fixture of the 1119 red-first tests (brief 1119, SO refund ronde 12 = docs/qa/
// second-opinion-refund-ronde12-1117.md, 2 x P1, tier K "jangan sampai rugi"). Written from
// that report, docs/briefs/1119-fix-refund-ronde12.md (CTO decisions) and
// docs/briefs/1072-invarian.md, on top of the refund-1072-harness; not from the
// implementation. Call `installSwitchHooks(h, true)` once at module level of a test file,
// after `createRefundHarness(tag)`.
//
// Rule behind every test (CTO decision): a hold may be closed as counted only when the
// provider facts booked for that refund id of that payment add up to at least the hold's
// amount. Nominal, not existence of a fact id. Below that the hold stays open and keeps
// counting against the refund limit; finance's `counted_against_intent` is refused 409
// (assumed code `REFUND_HOLD_FACT_SHORT`, the brief says "mis."); the hold is never lowered.

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import { env } from "../config/env";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  setPaymentRefundGateway,
} from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  type Code,
  type HoldRow,
  type RefundHarness,
} from "./refund-1072-harness";

export const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
export const newId = () => `rf_${randomBytes(6).toString("hex")}`;
export const REFUSED = [409, 422];
export const FACT_SHORT_CODE = "REFUND_HOLD_FACT_SHORT";
export const OWN_IDR = 10_000;

/** Registered after the harness hooks, so these run after them. The switch starts as `initial`. */
export function installSwitchHooks(h: RefundHarness, initial: boolean) {
  const before = flags.DOIT_REFUNDS_ENABLED;
  beforeEach(() => {
    flags.DOIT_REFUNDS_ENABLED = initial;
    resetPaymentRefundGateways();
    registerPaymentRefundGateway(h.fake);
  });
  afterEach(() => {
    flags.DOIT_REFUNDS_ENABLED = false;
    setPaymentRefundGateway(null);
  });
  afterAll(() => {
    flags.DOIT_REFUNDS_ENABLED = before;
  });
}

/** Recorder door report (`payment.refunded`): a new envelope id on every call. */
export const recorderReport = (
  h: RefundHarness,
  code: Code,
  x: string,
  amountIdr: number,
) => h.refundIdEvent(code.providerRef, x, amountIdr);

/** Signed `refund.succeeded` keyed to R of T1 that names refund X of payment T2: the mismatch door. */
export const mismatchReport =
  (t2: Code, refundId: string, x: string, amountIdr: number) => () => ({
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      object: "refund",
      id: x,
      idempotency_key: `refund:${refundId}`,
      payment_id: t2.providerRef,
      status: "succeeded",
      amount: amountIdr,
    },
  });

export const maxOpen = async (h: RefundHarness, intentId: string) =>
  Math.max(0, ...(await h.openOf(intentId)).map((row) => row.amount_idr));

export async function holdById(h: RefundHarness, intentId: string, id: string) {
  const row = (await h.allHolds(intentId)).find((hold) => hold.id === id);
  if (!row) throw new Error(`No hold ${id}`);
  return row;
}

export type MismatchWorld = {
  t1: Code;
  t2: Code;
  refundId: string;
  x: string;
  hold: HoldRow;
};

/**
 * SO P1-1: T1 with our refund R completed, T2 paid Rp100.000 with fact X/T2 of `fact`
 * booked by the recorder (nothing held), the switch set to `switchOn`, then a signed success
 * keyed R of T1 that names X of T2 with `hold` opens a REFERENCE_MISMATCH hold on T2.
 */
export async function mismatchWorld(
  h: RefundHarness,
  opts: { hold: number; fact: number; switchOn: boolean },
): Promise<MismatchWorld> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t1, OWN_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  const x = newId();

  await h.replayAll(() => recorderReport(h, t2, x, opts.fact), 1);
  expect(
    await h.providerRows(t2.id),
    `premise: fact X Rp${opts.fact} of T2 booked (holds: ${JSON.stringify(await h.allHolds(t2.id))})`,
  ).toMatchObject([{ provider_refund_id: x, amount_idr: opts.fact }]);
  expect(await h.openOf(t2.id), "premise: no hold on T2 yet").toHaveLength(0);

  flags.DOIT_REFUNDS_ENABLED = opts.switchOn;
  await h.replayAll(mismatchReport(t2, own.refundId, x, opts.hold), 1);
  const open = await h.openOf(t2.id);
  const holds = JSON.stringify(await h.allHolds(t2.id));
  expect(
    open.length,
    `premise: the mismatch report opened a hold on T2 (holds: ${holds})`,
  ).toBeGreaterThanOrEqual(1);
  const hold = open.reduce((a, b) => (b.amount_idr > a.amount_idr ? b : a));
  expect(
    hold.amount_idr,
    `premise: the open hold is worth the reported Rp${opts.hold} (holds: ${holds})`,
  ).toBeGreaterThanOrEqual(opts.hold);
  expect(
    await h.providerRows(t2.id),
    "premise: the mismatch report booked no fact",
  ).toMatchObject([{ provider_refund_id: x, amount_idr: opts.fact }]);
  return { t1, t2, refundId: own.refundId, x, hold };
}

/** Finance chooses `counted_against_intent` on a mismatch hold (it names X already, else X is given). */
export const countMismatch = (
  h: RefundHarness,
  w: Pick<MismatchWorld, "hold" | "x">,
) =>
  h.resolveHold(
    w.hold.id,
    "counted_against_intent",
    w.hold.provider_refund_id === null ? w.x : undefined,
  );

export type LiveOwnWorld = { code: Code; x: string; hold: HoldRow };

/**
 * SO P1-2: T paid Rp100.000, our refund R (Rp10.000) sent and timed out (approved, no
 * provider ref), a signed `payment.refunded` X/T of `hold` held as live-own, then R is
 * declined (the lookup the retry route uses) and every other open hold (the failure hold
 * of R) is closed `not_this_intent`, as finance does. The hold X stays open. Nothing ran
 * the worker after R failed, so the stored report of `hold` is not yet re-processed.
 * `factFirst`: a fact X/T of that amount is booked before R is filed.
 */
export async function liveOwnWorld(
  h: RefundHarness,
  opts: { hold: number; factFirst?: number },
): Promise<LiveOwnWorld> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const x = newId();
  if (opts.factFirst !== undefined) {
    await h.replayAll(() => recorderReport(h, code, x, opts.factFirst!), 1);
    expect(
      await h.providerRows(code.id),
      `premise: fact X Rp${opts.factFirst} booked (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
    ).toMatchObject([{ provider_refund_id: x, amount_idr: opts.factFirst }]);
  }

  const filed = await h.manualRefund(code.id, OWN_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  h.fake.enqueue("throw");
  const approved = await h.approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(await h.refundRow(refundId), "premise: R in flight").toMatchObject({
    status: "approved",
    provider_ref: null,
  });

  // A direct delivery, not `replayAll`: its worker pass would book the fact X at the
  // full amount while R is still in flight (hold and fact then match), but the
  // scenario is a hold WITHOUT its fact (second opinion: "before the worker repeats X80").
  // The webhook answers 5xx on purpose here (the provider retries).
  await h.deliver(recorderReport(h, code, x, opts.hold));
  const live = (await h.openOf(code.id)).filter(
    (row) => row.amount_idr >= opts.hold,
  );
  expect(
    live,
    `premise: the report X Rp${opts.hold} is held (holds: ${JSON.stringify(await h.allHolds(code.id))})`,
  ).toHaveLength(1);

  h.fake.setStatus(`refund:${refundId}`, {
    status: "failed",
    providerRef: `PR-DECLINED-${randomBytes(4).toString("hex")}`,
    code: "declined",
  });
  const retried = await h.retryRefund(refundId);
  expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  expect((await h.refundRow(refundId)).status, "premise: R failed").toBe(
    "failed",
  );
  for (const other of (await h.openOf(code.id)).filter(
    (row) => row.id !== live[0]!.id,
  )) {
    const closed = await h.resolveHold(other.id, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }
  const open = await h.openOf(code.id);
  expect(
    open.map((row) => row.id),
    "premise: only the hold X is open",
  ).toEqual([live[0]!.id]);
  return { code, x, hold: open[0]! };
}

export type Probe = {
  amountIdr: number;
  accepted: boolean;
  stage: "request" | "approve" | "settle" | "completed";
  status: number;
};

/**
 * Try to send money out by hand: file a refund, approve it and, when it waits for finance
 * (switch off), settle it by hand. `accepted` = money would leave (completed or settled 200).
 * A refusal must be 409/422; any other status fails loudly (a setup problem, not behaviour).
 */
export async function tryManualOut(
  h: RefundHarness,
  intentId: string,
  amountIdr: number,
): Promise<Probe> {
  const filed = await h.manualRefund(intentId, amountIdr);
  if (filed.status !== 201) {
    expect(
      REFUSED,
      `requesting ${amountIdr}: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
    return {
      amountIdr,
      accepted: false,
      stage: "request",
      status: filed.status,
    };
  }
  const refundId = filed.body.data.id as string;
  const approved = await h.approveRefund(refundId);
  if (approved.status !== 200 && approved.status !== 503) {
    expect(
      REFUSED,
      `approving ${amountIdr}: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
    return {
      amountIdr,
      accepted: false,
      stage: "approve",
      status: approved.status,
    };
  }
  if ((await h.refundRow(refundId)).status === "completed")
    return { amountIdr, accepted: true, stage: "completed", status: 200 };
  const settled = await h.settleManually(refundId, amountIdr);
  if (settled.status === 200)
    return { amountIdr, accepted: true, stage: "settle", status: 200 };
  expect(
    REFUSED,
    `settling ${amountIdr} by hand: ${JSON.stringify(settled.body)}`,
  ).toContain(settled.status);
  return {
    amountIdr,
    accepted: false,
    stage: "settle",
    status: settled.status,
  };
}

export function expectRefused(probe: Probe, label: string) {
  expect(
    probe.accepted,
    `${label}: manual refund of Rp${probe.amountIdr} must be refused, got ${JSON.stringify(probe)}`,
  ).toBe(false);
}

/**
 * Worst case, the provider report is real: out = the larger of what was reported and what
 * is booked, plus every manual refund that was let through. It must stay within what was paid.
 */
export function expectWorstCaseWithinPaid(
  reportedIdr: number,
  factIdr: number,
  probes: Probe[],
  label: string,
  paidIdr: number = BILL_IDR,
) {
  const manual = probes
    .filter((probe) => probe.accepted)
    .reduce((sum, probe) => sum + probe.amountIdr, 0);
  const out = Math.max(reportedIdr, factIdr) + manual;
  expect(
    out,
    `${label}: provider report/fact Rp${Math.max(reportedIdr, factIdr)} + manual refunds Rp${manual} = Rp${out} exceed what was paid (Rp${paidIdr}); probes ${JSON.stringify(probes)}`,
  ).toBeLessThanOrEqual(paidIdr);
}
