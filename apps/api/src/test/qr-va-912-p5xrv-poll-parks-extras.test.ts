// legend-p5xrv (912, part C): the ordinary payment poll also parks every
// further provider transaction of a still-pending code.
//
// Rule under test (docs/briefs/912-3p1.md, written from the brief, not from the
// implementation): when the provider answers a status read for a pending code
// with extra transactions (`extraPayments` of GatewayPaymentStatus, the Duitku
// shape "another reference paid"), the ordinary poll (the worker sweep
// `pollPendingGatewayIntents` and the guest's own `GET /payments/:id`) parks
// each of them as unallocated funds EXACTLY ONCE per provider + providerRef:
// - repeated polls never add a second fund, evidence row or
//   `payment.funds_unallocated` event;
// - the same provider ref arriving by webhook (recordUnsettledGatewayFunds) and
//   by poll, in either order, is one fund;
// - extra funds never settle the order. Only the code's own paid answer does,
//   once;
// - an amount <= 0 parks nothing.
//
// Assumptions:
// - Both a VA code (guest request) and a QR code (cashier tender) are covered;
//   QR has no payment link, so "not settled" is read from the intent status.
// - The intent `expires_at` is moved 30 days ahead so the code stays live and
//   each poll run (2 h apart, "now" injected) is past the poll's grace and
//   backoff for a fresh code.
// - The Duitku shape: primary status "pending" plus `extraPayments`.
// - A webhook for an extra provider ref is `recordUnsettledGatewayFunds` with
//   that ref (the function named by the brief).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-p5xrv-poll-parks-extras.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import {
  pollPendingGatewayIntents,
  recordUnsettledGatewayFunds,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  holdFixture,
  issueQris,
  newSubmittedOrder,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import { evidenceRows, outboxCountOf } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXTRA_IDR = 12_345;

let fx: HoldFixture;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code (by the
 * code's own provider ref), layered over the scripted gateway. */
const extrasByRef = new Map<string, Extra[]>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-912-p5xrv");
  enableVaBank(fx.gateway);
  const port = fx.gateway as unknown as {
    getStatus(input: {
      providerRef: string;
      intentId?: string;
    }): Promise<GatewayPaymentStatus>;
  };
  const original = port.getStatus.bind(fx.gateway);
  port.getStatus = async (input) => {
    const base = await original(input);
    const extras = extrasByRef.get(input.providerRef);
    return extras ? { ...base, extraPayments: extras } : base;
  };
  setPaymentGateway(fx.gateway);
});
afterAll(async () => {
  extrasByRef.clear();
  resetHoldPorts();
  await owner.end();
});

// ---------------------------------------------------------------- shared bits

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

type Subject = {
  intentId: string;
  providerRef: string;
  amount: number;
  orderId: string;
  /** VA only. */
  linkId?: string;
  guest?: Guest;
};

type Kind = {
  label: "VA" | "QR";
  /** A live pending code (provider pending, expires_at 30 days ahead). */
  open(): Promise<Subject>;
};

function extra(amountIdr: number = EXTRA_IDR, ref = `EXTRA-${randomUUID()}`) {
  return { providerRef: ref, amountIdr } satisfies Extra;
}

function answer(s: Subject, provider: ProviderAnswer, extras?: Extra[]) {
  fx.gateway.script(s.intentId, provider);
  if (extras) extrasByRef.set(s.providerRef, extras);
  else extrasByRef.delete(s.providerRef);
}

async function intentRow(s: Subject) {
  const { rows } = await owner.query<{
    id: string;
    outlet_id: string;
    amount_idr: number;
    method: string;
    provider: string;
    status: string;
  }>(
    `SELECT id, outlet_id, amount_idr::int AS amount_idr, method, provider, status
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, s.intentId],
  );
  return rows[0]!;
}

async function setExpiry(intentId: string, expiresAt: Date) {
  await owner.query(
    "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId, expiresAt],
  );
}

async function funds(s: Subject) {
  return (await unallocatedFunds(fx, s.intentId))
    .map((f) => f.amountIdr)
    .sort((a, b) => a - b);
}

/** Every provider transaction parked once: one fund, one evidence row and one
 * `payment.funds_unallocated` event per amount. */
async function expectParked(s: Subject, amounts: number[]) {
  const expected = [...amounts].sort((a, b) => a - b);
  expect(await funds(s)).toEqual(expected);
  expect(await evidenceRows(fx, s.intentId)).toHaveLength(expected.length);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    expected.length,
  );
}

/** Funds are parked open: nothing resolved them by itself. */
async function expectParkedOpen(s: Subject) {
  for (const fund of await unallocatedFunds(fx, s.intentId))
    expect(fund.resolution, "parked funds stay open").toBeNull();
}

/** Money applied to the order by the code itself (0 = still unpaid). */
async function settled(kind: Kind, s: Subject): Promise<number> {
  if (kind.label === "VA") {
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, s.linkId],
    );
    return rows[0]!.paid;
  }
  return (await intentRow(s)).status === "paid" ? s.amount : 0;
}

// Each poll run is later than the last: past the poll's grace for a fresh code
// and past the backoff between two asks about the same code.
let pollClock = Date.now();
function poll() {
  pollClock += 2 * HOUR;
  return pollPendingGatewayIntents(fx.context, new Date(pollClock), 200);
}

/** The webhook of an extra provider ref: the same parking function. */
async function webhookOfExtra(s: Subject, e: Extra) {
  const row = await intentRow(s);
  await recordUnsettledGatewayFunds(
    fx.context,
    {
      id: row.id,
      outletId: row.outlet_id,
      amountIdr: row.amount_idr,
      method: row.method,
      provider: row.provider,
      status: row.status,
    } as never,
    {
      provider: row.provider,
      providerRef: e.providerRef,
      source: "verified_webhook",
      paidAmountIdr: e.amountIdr,
      receivedAt: new Date(),
    },
    new Date(),
  );
}

// ------------------------------------------------------------------- kinds

const vaKind: Kind = {
  label: "VA",
  async open() {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const created = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
      payment_link_id: string;
    }>(
      `SELECT amount_idr::int AS amount, provider_ref,
              payment_link_id::text AS payment_link_id
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    await setExpiry(intentId, new Date(Date.now() + 30 * DAY));
    fx.gateway.script(intentId, { rawStatus: "01" });
    return {
      intentId,
      providerRef: rows[0]!.provider_ref,
      amount: rows[0]!.amount,
      orderId: order.id,
      linkId: rows[0]!.payment_link_id,
      guest,
    };
  },
};

const qrKind: Kind = {
  label: "QR",
  async open() {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    await setExpiry(qr.intentId, new Date(Date.now() + 30 * DAY));
    fx.gateway.script(qr.intentId, { rawStatus: "01" });
    return {
      intentId: qr.intentId,
      providerRef: qr.providerRef!,
      amount: qr.amountIdr,
      orderId: order.id,
    };
  },
};

// -------------------------------------------------------------------- tests

describe.each([vaKind, qrKind])(
  "legend-p5xrv $label ordinary poll parks extra transactions",
  (kind) => {
    const name = (text: string) => `legend-p5xrv ${kind.label} ${text}`;

    it(
      name(
        "primary pending + another reference paid: parked exactly once across repeated polls; the order is not settled",
      ),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra()]);

        await poll();
        await expectParked(s, [EXTRA_IDR]);
        for (let i = 0; i < 3; i += 1) {
          await poll();
          await expectParked(s, [EXTRA_IDR]);
        }
        await expectParkedOpen(s);
        expect(await settled(kind, s), "extra funds never settle").toBe(0);
        expect((await intentRow(s)).status).not.toBe("paid");
      },
    );

    it(
      name("a later extra is parked once and the earlier ones are untouched"),
      async () => {
        const s = await kind.open();
        const first = extra();
        const second = extra(7_000);
        answer(s, { rawStatus: "01" }, [first]);
        await poll();
        await poll();
        await expectParked(s, [EXTRA_IDR]);

        answer(s, { rawStatus: "01" }, [first, second]);
        await poll();
        await poll();
        await expectParked(s, [EXTRA_IDR, 7_000]);
        expect(await settled(kind, s)).toBe(0);
      },
    );

    it(
      name("two extras reported in one answer are both parked, once each"),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra(), extra(21_000)]);
        await poll();
        await poll();
        await expectParked(s, [EXTRA_IDR, 21_000]);
        expect(await settled(kind, s)).toBe(0);
      },
    );

    it(
      name(
        "poll and webhook of the same extra provider reference are one fund, in either order",
      ),
      async () => {
        const s = await kind.open();

        // Poll first, then the webhook of the same reference, then poll again.
        const viaPoll = extra();
        answer(s, { rawStatus: "01" }, [viaPoll]);
        await poll();
        await webhookOfExtra(s, viaPoll);
        await poll();
        await expectParked(s, [EXTRA_IDR]);

        // Webhook first, then the poll reports the same reference.
        const viaWebhook = extra(9_000);
        await webhookOfExtra(s, viaWebhook);
        answer(s, { rawStatus: "01" }, [viaPoll, viaWebhook]);
        await poll();
        await poll();
        await expectParked(s, [EXTRA_IDR, 9_000]);
        expect(await settled(kind, s)).toBe(0);
      },
    );

    it(name("an extra with amount 0 or less parks nothing"), async () => {
      const s = await kind.open();
      answer(s, { rawStatus: "01" }, [extra(0), extra(-500)]);
      await poll();
      await poll();
      expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
      expect(await evidenceRows(fx, s.intentId)).toEqual([]);
      expect(
        await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
      ).toBe(0);
      expect(await settled(kind, s)).toBe(0);
    });

    it(
      name("control: a pending code without extras parks nothing"),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" });
        await poll();
        await poll();
        expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
        expect(await evidenceRows(fx, s.intentId)).toEqual([]);
        expect(await settled(kind, s)).toBe(0);
      },
    );

    it(
      name(
        "primary paid + extra: the code settles the order once, the extra is parked once and never settles",
      ),
      async () => {
        const s = await kind.open();
        answer(s, { status: "paid" }, [extra()]);

        await poll();
        await poll();
        await poll();
        expect(await settled(kind, s), "settled exactly once").toBe(s.amount);
        expect((await intentRow(s)).status).toBe("paid");
        // Only the extra is parked: the primary payment settled the order.
        expect(await funds(s)).toEqual([EXTRA_IDR]);
        await expectParkedOpen(s);
        expect(
          await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
        ).toBe(1);
      },
    );
  },
);

// The guest's own status read (GET /payments/:id) is the other ordinary poll.
describe("legend-p5xrv VA guest status read parks extra transactions", () => {
  async function guestRead(s: Subject) {
    return agent(fx.app)
      .get(`/api/table-sessions/${s.guest!.sessionId}/payments/${s.intentId}`)
      .set(fx.headers)
      .set(originHeader)
      .set("Authorization", `Bearer ${s.guest!.token}`);
  }

  it("legend-p5xrv VA repeated guest reads and a worker poll park the extra exactly once", async () => {
    const s = await vaKind.open();
    answer(s, { rawStatus: "01" }, [extra()]);

    for (let i = 0; i < 3; i += 1) {
      const res = await guestRead(s);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("pending");
      await expectParked(s, [EXTRA_IDR]);
    }
    await poll();
    await poll();
    await expectParked(s, [EXTRA_IDR]);
    await expectParkedOpen(s);
    expect(await settled(vaKind, s), "extra funds never settle").toBe(0);
  });
});
