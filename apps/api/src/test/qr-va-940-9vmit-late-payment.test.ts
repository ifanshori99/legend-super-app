// legend-940 legend-9vmit: a guest who changes the payment method or bank on a
// bill gets the old VA code VOIDED first (founder Q15). This file covers the
// MONEY side: what happens when a payment still lands on the voided code.
//
// Written from brief-9vmit.md (design points 1 and 4) and the existing 912/940
// tests, not from the implementation.
//
// Rules under test
// - After the swap the old code is dead for the bill: money that still arrives
//   on it is ALWAYS parked as unallocated funds (open, waiting for a refund
//   decision) exactly once, never settles the bill, even when the same payment
//   notice is delivered twice or the provider poll reports it.
// - The NEW code, when paid, settles the bill exactly once. Both orders (old
//   money first, new money first) end in the same state: bill paid once, the old
//   amount parked once. Everything received = booked on the bill + parked.
// - If the provider already reports the old code PAID, the swap is refused
//   (409), no new code exists, no release row exists, and the bill is settled
//   by that payment once.
// - If the provider cannot be read, or its answer is older than 30 s when the
//   write happens, the swap is refused (409): no new code, no release row, the
//   old code stays live (a payment on it still settles the bill). Retrying with
//   a fresh answer succeeds.
//
// Assumptions (also in the report)
// - Swap = same guest order, VA bank "bmri" -> VA bank "bni" (POST
//   /payments, whole order target, new idempotency key). The scripted gateway
//   lists "bni" as a second VA bank in this file only.
// - A successful swap answers 201 with the NEW intent in body.data.id; the old
//   intent turns locally `expired` and exactly one payment_va_releases row with
//   kind 'guest_method_change' and status 'open' exists for it.
// - "Parked, refund queue" = one open (resolution null) payment_unallocated_funds
//   row of the OLD intent. Whether a refund row is created automatically is not
//   pinned and not asserted.
// - Late money on the old code arrives either as a verified webhook
//   (confirmPayment, method va) or as a provider status read by the VA release
//   recon job (scripted answer paid). A webhook error on the old code is
//   swallowed, the observable effect is asserted (as in the xzu4l test).
// - Refusal bodies: 409. The error code and wording are not pinned for the
//   unreadable/stale/paid cases (the brief gives guest wording, not a code).
// - "Answer older than 30 s" is produced as in the 24ogm test: the process Date
//   is skewed by 90 s right after the provider answered, only for that request.
// - Split parts are not covered here (the money rule is the same code path);
//   the swap flow for whole order and split part is in the guest-swap file.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-940-9vmit-late-payment.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { PaymentChannel } from "@starter/shared/payment";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { evidenceRows, outboxCountOf } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const BNI: PaymentChannel = { code: "bni", name: "BNI" };

let fx: HoldFixture;
/** Run once right after the provider answered a read of this provider ref. */
const afterRead = new Map<string, () => void>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-940-9vmit-late");
  enableVaBank(fx.gateway);
  const port = fx.gateway as unknown as {
    getStatus(input: {
      providerRef: string;
      intentId?: string;
    }): Promise<Awaited<ReturnType<HoldFixture["gateway"]["getStatus"]>>>;
    channels(
      context: ScopedTenantContext,
      method?: string,
    ): Promise<PaymentChannel[]>;
  };
  const read = port.getStatus.bind(fx.gateway);
  port.getStatus = async (input) => {
    const answer = await read(input);
    const hook = afterRead.get(input.providerRef);
    if (hook) {
      afterRead.delete(input.providerRef);
      hook();
    }
    return answer;
  };
  port.channels = async (_context, method) =>
    method === "va" ? [{ code: "bmri", name: "Mandiri" }, BNI] : [];
  setPaymentGateway(fx.gateway);
});
afterEach(() => {
  afterRead.clear();
  removeSkew();
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------ clock skew only

const RealDate = Date;
let skewMs = 0;
class SkewedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + skewMs);
    else super(...(args as [number]));
  }
  static override now() {
    return RealDate.now() + skewMs;
  }
}
function installSkew() {
  globalThis.Date = SkewedDate as unknown as DateConstructor;
}
function removeSkew() {
  skewMs = 0;
  globalThis.Date = RealDate;
}

// ------------------------------------------------------------------- fixtures

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

type Bill = {
  guest: Guest;
  orderId: string;
  linkId: string;
  /** The first code (VA bmri). */
  oldId: string;
  oldRef: string;
  amount: number;
};

function payRequest(guest: Guest, orderId: string, bankCode: "bmri" | "bni") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method: "va",
    bankCode,
    idempotencyKey: randomUUID(),
  });
}

/** A guest bill with a live VA code at bank bmri. */
async function billWithOldCode(): Promise<Bill> {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const created = await payRequest(guest, order.id, "bmri");
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const oldId = created.body.data.id as string;
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
    payment_link_id: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref,
            payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, oldId],
  );
  fx.gateway.script(oldId, { rawStatus: "01" });
  return {
    guest,
    orderId: order.id,
    linkId: rows[0]!.payment_link_id,
    oldId,
    oldRef: rows[0]!.provider_ref,
    amount: rows[0]!.amount,
  };
}

/** The guest picks another bank. */
const swap = (b: Bill) => payRequest(b.guest, b.orderId, "bni");

type NewCode = { id: string; ref: string; amount: number };

/** A swap that must succeed; returns the new code. */
async function swapOk(b: Bill): Promise<NewCode> {
  const res = await swap(b);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  expect(id, "a NEW code, not the old one").not.toBe(b.oldId);
  const { rows } = await owner.query<{ amount: number; provider_ref: string }>(
    "SELECT amount_idr::int AS amount, provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, id],
  );
  return { id, ref: rows[0]!.provider_ref, amount: rows[0]!.amount };
}

async function intentIdsOnLink(b: Bill): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id::text AS id FROM payment_intents WHERE tenant_id=$1 AND payment_link_id=$2 ORDER BY created_at, id",
    [fx.tenant.tenantId, b.linkId],
  );
  return rows.map((r) => r.id);
}

async function intentState(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_final_at: Date | null;
  }>(
    "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function releaseRows(intentId: string) {
  const { rows } = await owner.query<{ kind: string; status: string }>(
    "SELECT kind, status FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

async function releaseRowCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function bookedIdr(b: Bill) {
  const { rows } = await owner.query<{ paid: number; total: number }>(
    "SELECT paid_idr::int AS paid, total_idr::int AS total FROM payment_links WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, b.linkId],
  );
  return rows[0]!;
}

async function parkedOf(intentId: string) {
  return (await unallocatedFunds(fx, intentId)).map((f) => f.amountIdr);
}

const vaRequests = () => fx.gateway.requests.filter((r) => r.method === "va");

/** A verified webhook "paid" for a code. Errors are swallowed (a voided code may
 * refuse to settle); the caller asserts the effect. */
async function webhook(intentId: string, ref: string, amountIdr: number) {
  try {
    await confirmPayment(
      fx.context,
      intentId,
      {
        source: "verified_webhook",
        method: "va",
        amountIdr,
        providerRef: ref,
        at: new Date().toISOString(),
      },
      { type: "system" },
      new Date(),
    );
  } catch {
    /* refused on a dead code: parked, asserted by the caller */
  }
}

async function runVaRecon(now: Date = new Date()) {
  const job = await tryImport<{
    runPaymentVaReleaseReconJob?: (
      context: ScopedTenantContext,
      now?: Date,
      options?: { force?: boolean },
    ) => Promise<unknown>;
  }>("../worker/payment-va-release-recon.job.ts", "VA release recon job");
  if (typeof job.runPaymentVaReleaseReconJob !== "function")
    throw new Error(
      "worker/payment-va-release-recon.job.ts must export runPaymentVaReleaseReconJob(context, now, { force })",
    );
  return job.runPaymentVaReleaseReconJob(fx.context, now, { force: true });
}

/** The old code is void: one guest_method_change row, open, old code dead. */
async function expectVoided(b: Bill) {
  const rows = await releaseRows(b.oldId);
  expect(rows, "exactly one void row for the old code").toHaveLength(1);
  expect(rows[0]!.kind).toBe("guest_method_change");
  expect(rows[0]!.status).toBe("open");
  expect((await intentState(b.oldId)).status).toBe("expired");
}

/** Old money is parked once: one open fund, one evidence row, one event. */
async function expectOldParkedOnce(b: Bill) {
  const funds = await unallocatedFunds(fx, b.oldId);
  expect(
    funds.map((f) => f.amountIdr),
    "the late money is parked exactly once",
  ).toEqual([b.amount]);
  expect(funds[0]!.resolution, "waiting in the refund queue").toBeNull();
  expect(await evidenceRows(fx, b.oldId)).toHaveLength(1);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", b.oldId)).toBe(1);
}

/** No money lost, none paid twice: what the provider received = what the bill
 * booked + what is parked; the bill never books more than it costs. */
async function expectNoOverpay(
  b: Bill,
  newId: string | null,
  receivedIdr: number,
) {
  const link = await bookedIdr(b);
  expect(
    link.paid,
    "the outlet never books more than the bill",
  ).toBeLessThanOrEqual(link.total);
  const parked = [
    ...(await parkedOf(b.oldId)),
    ...(newId ? await parkedOf(newId) : []),
  ].reduce((sum, n) => sum + n, 0);
  expect(link.paid + parked, "booked + parked = received").toBe(receivedIdr);
}

// ----------------------------------------------------------- 1. old pays late

describe("legend-9vmit money lands on the voided OLD code", () => {
  it("legend-9vmit old code paid by webhook after the swap: parked once (replay safe), the bill is NOT paid, the new code still settles it once", async () => {
    const b = await billWithOldCode();
    const next = await swapOk(b);
    await expectVoided(b);

    await webhook(b.oldId, b.oldRef, b.amount);
    await webhook(b.oldId, b.oldRef, b.amount); // same notice delivered twice

    await expectOldParkedOnce(b);
    expect((await bookedIdr(b)).paid, "old code never pays the bill").toBe(0);
    expect((await intentState(next.id)).status, "new code untouched").toBe(
      "pending",
    );
    await expectNoOverpay(b, next.id, b.amount);

    // The new code, when paid, settles the bill once (also on a replay).
    await webhook(next.id, next.ref, next.amount);
    await webhook(next.id, next.ref, next.amount);
    expect((await bookedIdr(b)).paid, "new code settles the bill once").toBe(
      next.amount,
    );
    await expectOldParkedOnce(b);
    await expectNoOverpay(b, next.id, b.amount + next.amount);
  });

  it("legend-9vmit reverse order: the new code is paid first, then the old code: the bill stays paid once and the old money is parked once", async () => {
    const b = await billWithOldCode();
    const next = await swapOk(b);

    await webhook(next.id, next.ref, next.amount);
    expect((await bookedIdr(b)).paid).toBe(next.amount);

    await webhook(b.oldId, b.oldRef, b.amount);
    await webhook(b.oldId, b.oldRef, b.amount);

    expect(
      (await bookedIdr(b)).paid,
      "the bill is not paid a second time",
    ).toBe(next.amount);
    await expectOldParkedOnce(b);
    expect(await parkedOf(next.id), "the paying code parks nothing").toEqual(
      [],
    );
    await expectNoOverpay(b, next.id, b.amount + next.amount);
  });

  it("legend-9vmit old code reported paid by the provider (recon): parked once across repeated runs, the bill is NOT paid, the row stays open, the new code settles the bill once", async () => {
    const b = await billWithOldCode();
    const next = await swapOk(b);

    fx.gateway.script(b.oldId, { status: "paid" });
    await runVaRecon();
    await runVaRecon();

    await expectOldParkedOnce(b);
    expect((await bookedIdr(b)).paid, "old code never pays the bill").toBe(0);
    const rows = await releaseRows(b.oldId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("guest_method_change");
    expect(
      rows[0]!.status,
      "a paid answer keeps being watched, never closed by itself",
    ).toBe("open");

    await webhook(next.id, next.ref, next.amount);
    expect((await bookedIdr(b)).paid).toBe(next.amount);
    await expectOldParkedOnce(b);
    await expectNoOverpay(b, next.id, b.amount + next.amount);
  });
});

// ------------------------------------------------------- 2. paid before swap

describe("legend-9vmit the old code was already paid when the guest asks to change", () => {
  it("legend-9vmit provider says the old code is PAID: no swap, no new code, no void row; the guest is shown the paid code and the bill is settled by that payment once", async () => {
    const b = await billWithOldCode();
    fx.gateway.script(b.oldId, { status: "paid" });
    const intentsBefore = await intentIdsOnLink(b);
    const createsBefore = vaRequests().length;

    // The poll before the swap already records the payment, so the guest gets
    // the paid old code back (never a new one). A paid answer that is only
    // seen by the void itself is refused with 409 (see the void service).
    const shown = await swap(b);

    expect(shown.status, JSON.stringify(shown.body)).toBe(201);
    expect(shown.body.data?.id).toBe(b.oldId);
    expect(shown.body.data?.status).toBe("paid");
    expect(await intentIdsOnLink(b), "no new code").toEqual(intentsBefore);
    expect(vaRequests().length, "no code asked from the provider").toBe(
      createsBefore,
    );
    expect(await releaseRowCount(b.oldId), "old code is not voided").toBe(0);
    // The payment is applied to the bill, once (like a staff release of a paid
    // code), not parked and not lost.
    expect((await bookedIdr(b)).paid, "the paid code settles the bill").toBe(
      b.amount,
    );
    expect(await parkedOf(b.oldId)).toEqual([]);

    // Asking again changes nothing and never pays twice.
    const again = await swap(b);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data?.id).toBe(b.oldId);
    expect(again.body.data?.status).toBe("paid");
    expect(await intentIdsOnLink(b)).toEqual(intentsBefore);
    expect((await bookedIdr(b)).paid).toBe(b.amount);
    await expectNoOverpay(b, null, b.amount);
  });
});

describe("legend-9vmit the old code is paid between the early poll and the void", () => {
  it("legend-9vmit the void's own provider read says PAID: swap refused 409, no new code, no void row, the bill is settled once", async () => {
    const b = await billWithOldCode();
    const intentsBefore = await intentIdsOnLink(b);
    const createsBefore = vaRequests().length;
    // The guest path polls the old code first (still pending); the payment
    // lands right after that poll, so only the void's read sees it.
    afterRead.set(b.oldRef, () => {
      fx.gateway.script(b.oldId, { status: "paid" });
    });

    const refused = await swap(b);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(typeof refused.body.error?.message).toBe("string");
    expect(await intentIdsOnLink(b), "no new code").toEqual(intentsBefore);
    expect(vaRequests().length, "no code asked from the provider").toBe(
      createsBefore,
    );
    expect(await releaseRowCount(b.oldId), "old code is not voided").toBe(0);
    expect((await bookedIdr(b)).paid, "the paid code settles the bill").toBe(
      b.amount,
    );
    expect(await parkedOf(b.oldId)).toEqual([]);
    await expectNoOverpay(b, null, b.amount);
  });
});

// --------------------------------------------- 3. provider unread or too old

describe("legend-9vmit the provider answer is missing or too old", () => {
  it("legend-9vmit provider unreadable: swap refused 409, no new code, no void row, old code stays live; once the provider answers, the retry succeeds", async () => {
    const b = await billWithOldCode();
    fx.gateway.script(b.oldId, { error: "timeout" });
    const intentsBefore = await intentIdsOnLink(b);
    const createsBefore = vaRequests().length;

    const refused = await swap(b);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(typeof refused.body.error?.message).toBe("string");
    expect(await intentIdsOnLink(b), "no new code").toEqual(intentsBefore);
    expect(vaRequests().length, "no code asked from the provider").toBe(
      createsBefore,
    );
    expect(await releaseRowCount(b.oldId), "no void row").toBe(0);
    const old = await intentState(b.oldId);
    expect(old.status).toBe("pending");
    expect(old.provider_final_at).toBeNull();

    // The provider answers again: the same guest can now switch.
    fx.gateway.script(b.oldId, { rawStatus: "01" });
    const next = await swapOk(b);
    await expectVoided(b);
    expect(next.id).not.toBe(b.oldId);
  });

  it("legend-9vmit provider unreadable: the old code stays live, a payment on it settles the bill once and nothing is parked", async () => {
    const b = await billWithOldCode();
    fx.gateway.script(b.oldId, { error: "5xx" });
    const refused = await swap(b);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await releaseRowCount(b.oldId)).toBe(0);

    await webhook(b.oldId, b.oldRef, b.amount);
    await webhook(b.oldId, b.oldRef, b.amount);

    expect((await bookedIdr(b)).paid, "the live code pays the bill").toBe(
      b.amount,
    );
    expect(await parkedOf(b.oldId), "nothing parked").toEqual([]);
    await expectNoOverpay(b, null, b.amount);
  });

  it("legend-9vmit provider answer 90 s old when the write happens: swap refused 409, no new code, no void row, old code live; a fresh retry succeeds", async () => {
    const b = await billWithOldCode();
    const intentsBefore = await intentIdsOnLink(b);
    const createsBefore = vaRequests().length;
    // Every read of the old code ages the clock 90 s afterwards, so the read
    // the void makes is 90 s old when the order lock is taken (the guest path
    // also polls the code earlier, which a one-shot hook would consume).
    const age = () => {
      skewMs += 90_000;
      afterRead.set(b.oldRef, age);
    };
    afterRead.set(b.oldRef, age);
    installSkew();
    let refused: Awaited<ReturnType<typeof swap>>;
    try {
      refused = await swap(b);
    } finally {
      removeSkew();
      afterRead.delete(b.oldRef);
    }

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await intentIdsOnLink(b), "no new code").toEqual(intentsBefore);
    expect(vaRequests().length, "no code asked from the provider").toBe(
      createsBefore,
    );
    expect(await releaseRowCount(b.oldId), "no void row").toBe(0);
    const old = await intentState(b.oldId);
    expect(old.status).toBe("pending");
    expect(old.provider_final_at).toBeNull();

    // The old code is still collectible (pending, not final). Retry with a
    // fresh answer.
    const next = await swapOk(b);
    await expectVoided(b);
    expect(next.id).not.toBe(b.oldId);
  });

  it("legend-9vmit control: a provider answer 5 s old is fresh enough, the swap succeeds once", async () => {
    const b = await billWithOldCode();
    afterRead.set(b.oldRef, () => {
      skewMs += 5_000;
    });
    installSkew();
    let res: Awaited<ReturnType<typeof swap>>;
    try {
      res = await swap(b);
    } finally {
      removeSkew();
    }

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.id).not.toBe(b.oldId);
    await expectVoided(b);
    expect(await intentIdsOnLink(b)).toHaveLength(2);
  });
});
