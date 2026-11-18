// Brief 1029, cards legend-kis0u, legend-p45yq, legend-nqfov (founder Q15:
// a method change voids the old QR/VA code; a late payment to it is refunded;
// nobody is paid twice). Written from the brief, the replay rule of legend-gp3fw
// (same key + same payload = the stored answer; same key + other payload = 409
// IDEMPOTENCY_KEY_REUSED) and the shared validators, not from the implementation.
//
// kis0u: replaying the key of a code that is no longer open must say what the
//   code is now (expired when voided or timed out, paid when paid), never
//   "pending". Only e-wallet/card were covered before; VA/QRIS carry no
//   redirect URL, so these are the gap.
// p45yq: same key replayed while a method change is (or was) running must
//   answer with the stored intent, never 409 ORDER_CODE_ACTIVE. 1004 covers the
//   service-level hook window; here the window is driven over HTTP with a
//   row lock (public token link), plus the sequential replays.
// nqfov: an e-wallet/card/VA replay uses the stored answer even when the method
//   or the channel is not offered any more; split part included.
//
// Assumptions (also in the report)
// - A closed-code replay is a 2xx with status "expired" (voided or timed out)
//   or a 4xx refusal; never a 5xx and never "pending". A paid split part's
//   replay is 2xx, status "paid", paidAt set, redirectUrl null.
// - A VA answer keeps its vaNumber even when closed (guestPaymentSchema needs
//   it for method va); the test only forbids "pending".
// - Replaying the key of the voided code never reopens it: its row stays
//   "expired", no new intent, no provider create, no second release row.
// - The p45yq race: a twin transaction (uncommitted) voids the live code O and
//   stores N for the key; the retry reads the key (nothing visible), meets the
//   row lock on O in its void step, and after the twin commits finds O already
//   closed (voided = []). It must replay N (2xx, same id), not 409.
// - Idempotency keys are tenant-scoped; another table session or another
//   tenant sending the same key must never be given the first guest's payment.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-1029-replay.test.ts" pnpm test
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { guestPaymentSchema } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { agent } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  bindLinkToOrder,
  intentCount,
  intentRow,
} from "./qr-va-912-3p1-helpers.ts";
import {
  setPaymentGateway,
  type GatewayCancelRequest,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

// ------------------------------------------------------------------ gateway

type Offered = {
  method: GatewayPaymentMethod;
  enabled: boolean;
  channels: { code: string; name: string }[];
};

const ALL_ON = (): Offered[] => [
  { method: "qris", enabled: true, channels: [] },
  {
    method: "va",
    enabled: true,
    channels: [
      { code: "BC", name: "BCA Virtual Account" },
      { code: "I1", name: "BNI Virtual Account" },
    ],
  },
  { method: "bank_transfer", enabled: false, channels: [] },
  {
    method: "ewallet",
    enabled: true,
    channels: [
      { code: "OV", name: "OVO" },
      { code: "DA", name: "DANA" },
    ],
  },
  {
    method: "card",
    enabled: true,
    channels: [{ code: "VC", name: "Credit Card" }],
  },
];

/** Duitku-like double: VA with two banks, e-wallet and card with a pay URL. */
class Gateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  offered: Offered[] = ALL_ON();
  failMethods = false;
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  readonly cancels: GatewayCancelRequest[] = [];
  private sequence = 0;
  readonly cancel = async (
    _context: ScopedTenantContext,
    intent: GatewayCancelRequest,
  ) => {
    this.cancels.push(intent);
  };
  reset() {
    this.offered = ALL_ON();
    this.failMethods = false;
    this.created.length = 0;
    this.cancels.length = 0;
  }
  setEnabled(method: GatewayPaymentMethod, enabled: boolean) {
    this.offered = this.offered.map((entry) =>
      entry.method === method ? { ...entry, enabled } : entry,
    );
  }
  removeChannel(method: GatewayPaymentMethod, code: string) {
    this.offered = this.offered.map((entry) =>
      entry.method === method
        ? { ...entry, channels: entry.channels.filter((c) => c.code !== code) }
        : entry,
    );
  }
  async health() {
    return { status: "available" as const };
  }
  async methods() {
    if (this.failMethods) throw new Error("gateway methods() unavailable");
    return this.offered;
  }
  async channels(_context: unknown, method?: GatewayPaymentMethod) {
    if (this.failMethods) throw new Error("gateway channels() unavailable");
    const entry = this.offered.find(
      (candidate) => candidate.method === method && candidate.enabled,
    );
    return entry ? entry.channels : [];
  }
  async createIntent(input: GatewayIntentRequest) {
    this.sequence += 1;
    const n = String(this.sequence).padStart(8, "0");
    const providerRef = `R1029-${randomUUID()}`;
    this.created.push({ providerRef, request: input });
    const channel = ALL_ON()
      .find((entry) => entry.method === input.method)
      ?.channels.find((c) => c.code === input.channelCode);
    let instructions: unknown;
    if (input.method === "va")
      instructions = {
        method: "va",
        channelCode: input.channelCode ?? "BC",
        channelName: channel?.name ?? "BCA Virtual Account",
        virtualAccountNumber: `8809${n}`,
      };
    else if (input.method === "ewallet" || input.method === "card")
      instructions = {
        method: input.method,
        channelCode: input.channelCode ?? "VC",
        channelName: channel?.name ?? "Credit Card",
        paymentUrl: `https://pay.example.test/${providerRef}`,
      };
    else
      instructions = {
        method: "qris",
        qrPayload: `00020101021226R1029${n}`,
        issuer: null,
      };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
}

let fx: HoldFixture;
let other: HoldFixture; // a second, isolated tenant
const gw = new Gateway();
const writerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

async function routeOn(tenantId: string, method: string, enabled: boolean) {
  await owner.query(
    `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
     VALUES ($1, NULL, $2, 'duitku', NULL, $3, 'system:test')
     ON CONFLICT DO NOTHING`,
    [tenantId, method, enabled],
  );
  await owner.query(
    "UPDATE payment_routing_rules SET enabled = $3 WHERE tenant_id = $1 AND method = $2",
    [tenantId, method, enabled],
  );
}

beforeAll(async () => {
  other = await holdFixture("qr-va-1029-other");
  fx = await holdFixture("qr-va-1029");
  // E-wallet and card have no default route (fail closed): switch them on.
  for (const tenantId of [fx.tenant.tenantId, other.tenant.tenantId])
    for (const method of ["ewallet", "card"])
      await routeOn(tenantId, method, true);
  setPaymentGateway(gw); // after both fixtures: each installs its own gateway
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await writerPool.end();
  await endPools();
});

// ------------------------------------------------------------------- helpers

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Method = "qris" | "va" | "ewallet" | "card";

const payOrder = (
  guest: Guest,
  orderId: string,
  method: Method,
  channel: string | undefined,
  idempotencyKey: string,
  via: HoldFixture = fx,
) =>
  via.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(channel === undefined ? {} : { bankCode: channel }),
    idempotencyKey,
  });

const payPart = (
  guest: Guest,
  partId: string,
  method: Method,
  channel: string | undefined,
  idempotencyKey: string,
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: partId },
    method,
    ...(channel === undefined ? {} : { bankCode: channel }),
    payerSecret: secretFor(partId),
    idempotencyKey,
  });

async function wholeOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  return { guest, order };
}

async function splitBill() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  expect(parts, "setup: two parts").toHaveLength(2);
  return { guest, order, parts };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

async function releaseCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_va_releases
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function linkIdOf(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_link_id: string }>(
    "SELECT payment_link_id::text AS payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, intentId],
  );
  expect(rows, "setup: the intent exists").toHaveLength(1);
  return rows[0]!.payment_link_id;
}

async function pendingOnLink(linkId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text AS id FROM payment_intents
      WHERE tenant_id = $1 AND payment_link_id = $2 AND status = 'pending'
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, linkId],
  );
  return rows.map((row) => row.id);
}

async function intentsOnLinkRows(linkId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status FROM payment_intents
      WHERE tenant_id = $1 AND payment_link_id = $2 ORDER BY created_at, id`,
    [fx.tenant.tenantId, linkId],
  );
  return rows;
}

/**
 * A replay of a key whose code is closed: never "pending" (the code must not
 * look payable again). 2xx says expired for the same intent; a 4xx is also
 * accepted. Never a 5xx.
 */
function expectClosedReplay(
  replay: { status: number; body: unknown },
  intentId: string,
) {
  expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(500);
  if (replay.status >= 300) return;
  const data = (replay.body as { data: Record<string, unknown> }).data;
  expect(data.id).toBe(intentId);
  expect(
    data.status,
    "a voided / timed-out code must not be answered as pending",
  ).toBe("expired");
  expect(data.redirectUrl).toBeNull();
  const parsed = guestPaymentSchema.safeParse(data);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
}

// ====================================================================== kis0u

describe("legend-kis0u replaying the key of a closed VA code says what it is now", () => {
  it("legend-kis0u whole order: the key of a VA voided by a bank swap is answered expired, never pending; the old code is not reopened, nothing new is created", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const oldKey = randomUUID();
    const first = await payOrder(guest, order.id, "va", "BC", oldKey);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const linkId = await linkIdOf(oldId);
    const swapped = await payOrder(guest, order.id, "va", "I1", randomUUID());
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;
    const releases = await releaseCount(oldId);
    expect(releases, "setup: one void row for the old code").toBe(1);

    const replay = await payOrder(guest, order.id, "va", "BC", oldKey);

    expectClosedReplay(replay, oldId);
    expect(
      (await intentRow(fx.tenant.tenantId, oldId)).status,
      "the voided code is not reopened",
    ).toBe("expired");
    expect(await pendingOnLink(linkId), "only the new code is live").toEqual([
      newId,
    ]);
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(gw.created, "no new provider code").toHaveLength(created);
    expect(await releaseCount(oldId), "no second void row").toBe(releases);
    expect(await releaseCount(newId), "the live code is not voided").toBe(0);
  });

  it("legend-kis0u whole order: the chain K1 (BCA) -> K2 (BNI) -> K3 (BCA again): replaying K2, whose code was voided by K3, is answered expired", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const k2 = randomUUID();
    const a = await payOrder(guest, order.id, "va", "BC", randomUUID());
    const b = await payOrder(guest, order.id, "va", "I1", k2);
    const c = await payOrder(guest, order.id, "va", "BC", randomUUID());
    for (const step of [a, b, c])
      expect(step.status, JSON.stringify(step.body)).toBe(201);
    const middleId = b.body.data.id as string;
    expect((await intentRow(fx.tenant.tenantId, middleId)).status).toBe(
      "expired",
    );
    const linkId = await linkIdOf(middleId);
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const replay = await payOrder(guest, order.id, "va", "I1", k2);

    expectClosedReplay(replay, middleId);
    expect(await pendingOnLink(linkId)).toEqual([c.body.data.id]);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(gw.created).toHaveLength(created);
  });

  it("legend-kis0u split part: the key of a part's VA voided by a bank swap is answered expired, the part's new code stays the only live one", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const part = parts[0]!;
    const oldKey = randomUUID();
    const first = await payPart(guest, part.id, "va", "BC", oldKey);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const swapped = await payPart(guest, part.id, "va", "I1", randomUUID());
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const replay = await payPart(guest, part.id, "va", "BC", oldKey);

    expectClosedReplay(replay, oldId);
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    expect((await intentRow(fx.tenant.tenantId, newId)).status).toBe("pending");
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(gw.created).toHaveLength(created);
  });

  it("legend-kis0u whole order: the key of a VA that timed out is answered expired, not pending; no new code", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const first = await payOrder(guest, order.id, "va", "BC", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const id = first.body.data.id as string;
    await owner.query(
      `UPDATE payment_intents SET status = 'expired',
              expires_at = now() - interval '10 minutes', provider_final_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [fx.tenant.tenantId, id],
    );
    const intents = await intentCount(fx.tenant.tenantId);

    const replay = await payOrder(guest, order.id, "va", "BC", key);

    expectClosedReplay(replay, id);
    expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("expired");
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(gw.created, "no second provider code").toHaveLength(1);
  });

  it("legend-kis0u split part: the key of a PAID VA part is answered paid with paidAt, no pay data of a live code, no second code; the other part keeps the order open", async () => {
    gw.reset();
    const { guest, order, parts } = await splitBill();
    const key = randomUUID();
    const created = await payPart(guest, parts[0]!.id, "va", "BC", key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const { rows: meta } = await owner.query<{
      amount: number;
      provider_ref: string;
    }>(
      `SELECT amount_idr::int AS amount, provider_ref FROM payment_intents
        WHERE tenant_id = $1 AND id = $2`,
      [fx.tenant.tenantId, id],
    );
    await confirmPayment(
      fx.context,
      id,
      {
        source: "verified_webhook",
        method: "va",
        amountIdr: meta[0]!.amount,
        providerRef: meta[0]!.provider_ref,
        at: new Date().toISOString(),
      } as Parameters<typeof confirmPayment>[2],
      { type: "system" },
      new Date(),
    );
    const { rows: events } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
          AND event->'payload'->>'intentId' = $2 ORDER BY created_at, id`,
      [fx.tenant.tenantId, id],
    );
    expect(events, "one payment.paid").toHaveLength(1);
    const context = fx.context as ScopedTenantContext;
    await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(
        context,
        eventEnvelopeSchema.parse(events[0]!.event),
        tx,
        new Date(),
      ),
    );
    expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("paid");
    const { rows: fired } = await owner.query<{ fired_at: Date | null }>(
      "SELECT fired_at FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(fired[0]!.fired_at, "setup: order not fully paid").toBeNull();
    const intents = await intentCount(fx.tenant.tenantId);

    const replay = await payPart(guest, parts[0]!.id, "va", "BC", key);

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data).toMatchObject({
      id,
      status: "paid",
      method: "va",
      redirectUrl: null,
    });
    expect(typeof replay.body.data.paidAt, "paidAt is an ISO string").toBe(
      "string",
    );
    const parsed = guestPaymentSchema.safeParse(replay.body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(JSON.stringify(replay.body)).not.toContain(meta[0]!.provider_ref);
    expect(gw.created, "no second provider code").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
  });
});

// ===================================================================== p45yq

describe("legend-p45yq the same key replayed around a method change answers with the stored intent", () => {
  it("legend-p45yq guest session: after a swap with key K, replaying K twice returns the same pending intent both times: no 409, no extra code, no extra payment, no extra void", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "BC", randomUUID());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const linkId = await linkIdOf(oldId);
    const key = randomUUID();
    const swapped = await payOrder(guest, order.id, "va", "I1", key);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;
    const releases = await releaseCount(oldId);

    for (let i = 0; i < 2; i += 1) {
      const again = await payOrder(guest, order.id, "va", "I1", key);
      expect(
        again.status,
        `replay ${i + 1}: ${JSON.stringify(again.body)}`,
      ).toBeLessThan(300);
      expect(again.body.data.id).toBe(newId);
      expect(again.body.data.status).toBe("pending");
      expect(again.body.data.vaNumber).toBe(swapped.body.data.vaNumber);
    }

    expect(gw.created, "no new provider code").toHaveLength(created);
    expect(await intentCount(fx.tenant.tenantId), "no new payment").toBe(
      intents,
    );
    expect(await releaseCount(oldId), "no second void of the old code").toBe(
      releases,
    );
    expect(await releaseCount(newId), "the new code is not voided").toBe(0);
    expect(await pendingOnLink(linkId)).toEqual([newId]);
  });

  it("legend-p45yq guest session: the same key with ANOTHER bank than the stored intent is 409 IDEMPOTENCY_KEY_REUSED; nothing is voided or created", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "BC", randomUUID());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const key = randomUUID();
    const swapped = await payOrder(guest, order.id, "va", "I1", key);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const reused = await payOrder(guest, order.id, "va", "BC", key);

    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(errorCode(reused.body), JSON.stringify(reused.body)).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(gw.created).toHaveLength(created);
    expect((await intentRow(fx.tenant.tenantId, newId)).status).toBe("pending");
    expect(await releaseCount(newId)).toBe(0);
  });

  it("legend-p45yq public token link: a twin voided the live code and stored N for key K while the retry waited on the old code; the retry replays N (same id, 2xx), never 409, no second code, N not voided", async () => {
    gw.reset();
    const order = await newSubmittedOrder(fx, 0);
    const { token, linkId } = await bindLinkToOrder(fx, order);
    const postLink = (channelCode: string, idempotencyKey: string) =>
      agent(fx.app)
        .post(`/api/payments/links/${token}/intents`)
        .send({ method: "va", channelCode, idempotencyKey });
    const live = await postLink("BC", randomUUID());
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const oldId = live.body.data.id as string;
    const key = randomUUID();
    // A faithful twin leaves the same void row a real swap leaves: clone the
    // row of a donor swap on another bill (no column names assumed).
    const donorOrder = await newSubmittedOrder(fx, 0);
    const donor = await bindLinkToOrder(fx, donorOrder);
    const postDonor = (channelCode: string) =>
      agent(fx.app)
        .post(`/api/payments/links/${donor.token}/intents`)
        .send({ method: "va", channelCode, idempotencyKey: randomUUID() });
    const donorOld = await postDonor("BC");
    expect(donorOld.status, JSON.stringify(donorOld.body)).toBe(201);
    const donorSwap = await postDonor("I1");
    expect(donorSwap.status, JSON.stringify(donorSwap.body)).toBe(201);
    const { rows: donorRows } = await owner.query<Record<string, unknown>>(
      "SELECT * FROM payment_va_releases WHERE tenant_id = $1 AND payment_intent_id = $2",
      [fx.tenant.tenantId, donorOld.body.data.id],
    );
    expect(donorRows, "setup: the donor swap left a void row").toHaveLength(1);
    const oldRef = (await intentRow(fx.tenant.tenantId, oldId))
      .provider_ref as string;
    const created = gw.created.length;

    const raw: PoolClient = await writerPool.connect();
    let open = true;
    const finish = async (sql: "COMMIT" | "ROLLBACK") => {
      if (!open) return;
      open = false;
      try {
        await raw.query(sql);
      } finally {
        raw.release();
      }
    };
    let twinId = "";
    let retry: { status: number; body: unknown };
    try {
      await raw.query("BEGIN");
      await raw.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      // The twin: closes the live code, stores N for the key. Not committed yet.
      await raw.query(
        `UPDATE payment_intents SET status = 'expired', provider_final_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [fx.tenant.tenantId, oldId],
      );
      const clone: Record<string, unknown> = { ...donorRows[0]! };
      if ("id" in clone) clone.id = randomUUID();
      if ("payment_intent_id" in clone) clone.payment_intent_id = oldId;
      if ("payment_link_id" in clone) clone.payment_link_id = linkId;
      if ("provider_ref" in clone) clone.provider_ref = oldRef;
      const cols = Object.keys(clone);
      await raw.query(
        `INSERT INTO payment_va_releases (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        cols.map((col) => clone[col]),
      );
      twinId = randomUUID();
      await raw.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider,
            provider_ref, amount_idr, idempotency_key, status, instructions,
            expires_at, channel_code)
         VALUES ($1, $2, $3, $4, 'va', $5, $6, $7, $8, 'pending', $9::jsonb,
                 now() + interval '4 minutes', 'I1')`,
        [
          twinId,
          fx.tenant.tenantId,
          fx.tenant.outletId,
          linkId,
          gw.provider,
          `TWIN-${twinId}`,
          order.totalIdr,
          key,
          JSON.stringify({
            method: "va",
            channelCode: "I1",
            channelName: "BNI Virtual Account",
            virtualAccountNumber: "8809123456789012",
          }),
        ],
      );
      let done = false;
      const settled = Promise.resolve(postLink("I1", key)).then(
        (response) => {
          done = true;
          return response;
        },
        (error: unknown) => {
          done = true;
          throw error;
        },
      );
      await vi.waitFor(
        async () => {
          if (done) return;
          const { rows } = await owner.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND state = 'active' AND wait_event_type = 'Lock'`,
          );
          if (rows[0]!.n === 0) throw new Error("request is not waiting yet");
        },
        { timeout: 30_000, interval: 50 },
      );
      await finish("COMMIT");
      retry = await settled;
    } finally {
      await finish("ROLLBACK");
    }

    expect(
      retry.status,
      `the retry must replay N, got ${errorCode(retry.body) ?? retry.status}: ${JSON.stringify(retry.body)}`,
    ).toBeLessThan(300);
    expect((retry.body as { data: { id: string } }).data.id).toBe(twinId);
    expect(gw.created, "the retry asks the provider for nothing").toHaveLength(
      created,
    );
    expect(
      (await intentsOnLinkRows(linkId)).map((row) => [row.id, row.status]),
    ).toEqual([
      [oldId, "expired"],
      [twinId, "pending"],
    ]);
    expect(await releaseCount(twinId), "N is not voided").toBe(0);
    expect(
      gw.cancels.map((cancel) => cancel.providerRef),
      "N is never cancelled at the provider",
    ).not.toContain(`TWIN-${twinId}`);
  });
});

// ===================================================================== nqfov

describe("legend-nqfov a replay uses the stored answer even if the method or channel is not offered any more", () => {
  it("legend-nqfov whole order e-wallet: the channel (OVO) is gone from the list while the method stays on: same key + same payload returns the same pending intent and pay URL", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const first = await payOrder(guest, order.id, "ewallet", "OV", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const intents = await intentCount(fx.tenant.tenantId);
    gw.removeChannel("ewallet", "OV");

    const replay = await payOrder(guest, order.id, "ewallet", "OV", key);

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.status).toBe("pending");
    expect(replay.body.data.redirectUrl).toBe(first.body.data.redirectUrl);
    expect(gw.created, "no second provider create").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
  });

  it("legend-nqfov whole order VA: the bank (BCA) is gone from the list: same key + same payload returns the same pending VA, no new code", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const first = await payOrder(guest, order.id, "va", "BC", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const intents = await intentCount(fx.tenant.tenantId);
    gw.removeChannel("va", "BC");

    const replay = await payOrder(guest, order.id, "va", "BC", key);

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.status).toBe("pending");
    expect(replay.body.data.vaNumber).toBe(first.body.data.vaNumber);
    expect(gw.created).toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
  });

  for (const brk of [
    {
      name: "gateway methods() throws",
      apply: async () => {
        gw.failMethods = true;
      },
    },
    {
      name: "the method is switched off at the gateway",
      apply: async () => {
        gw.setEnabled("ewallet", false);
      },
    },
    {
      name: "tenant routing for e-wallet is disabled",
      apply: async () => {
        await routeOn(fx.tenant.tenantId, "ewallet", false);
      },
    },
  ]) {
    it(`legend-nqfov split part e-wallet: ${brk.name}: same key + same payload returns the same pending intent and URL; one provider create, no void`, async () => {
      gw.reset();
      await routeOn(fx.tenant.tenantId, "ewallet", true);
      const { guest, parts } = await splitBill();
      const part = parts[0]!;
      const key = randomUUID();
      const first = await payPart(guest, part.id, "ewallet", "OV", key);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const id = first.body.data.id as string;
      const intents = await intentCount(fx.tenant.tenantId);
      await brk.apply();

      try {
        const replay = await payPart(guest, part.id, "ewallet", "OV", key);

        expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
        expect(replay.body.data).toMatchObject({
          id,
          status: "pending",
          method: "ewallet",
          target: { kind: "split", billSplitId: part.id },
        });
        expect(replay.body.data.redirectUrl).toBe(first.body.data.redirectUrl);
        expect(typeof replay.body.data.redirectUrl).toBe("string");
        expect(gw.created, "no second provider create").toHaveLength(1);
        expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
          intents,
        );
        expect(await releaseCount(id), "no void").toBe(0);
        expect((await intentRow(fx.tenant.tenantId, id)).status).toBe(
          "pending",
        );
      } finally {
        await routeOn(fx.tenant.tenantId, "ewallet", true);
      }
    });
  }

  it("legend-nqfov split part e-wallet: methods() throws, same key + ANOTHER channel is 409 IDEMPOTENCY_KEY_REUSED, nothing created or voided", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const part = parts[0]!;
    const key = randomUUID();
    const first = await payPart(guest, part.id, "ewallet", "OV", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const id = first.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    gw.failMethods = true;

    const reused = await payPart(guest, part.id, "ewallet", "DA", key);

    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(errorCode(reused.body), JSON.stringify(reused.body)).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(gw.created).toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(await releaseCount(id)).toBe(0);
    expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("pending");
  });

  it("legend-nqfov a double replay with the method broken creates no code and no payment", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const first = await payOrder(guest, order.id, "card", undefined, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const intents = await intentCount(fx.tenant.tenantId);
    gw.failMethods = true;

    for (let i = 0; i < 2; i += 1) {
      const replay = await payOrder(guest, order.id, "card", undefined, key);
      expect(
        replay.status,
        `replay ${i + 1}: ${JSON.stringify(replay.body)}`,
      ).toBeLessThan(300);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(replay.body.data.redirectUrl).toBe(first.body.data.redirectUrl);
    }

    expect(gw.created, "no second provider create").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
  });
});

// ================================================================== isolation

describe("legend-kis0u / legend-nqfov a replay never hands one guest's payment to another", () => {
  it("legend-nqfov another tenant's guest sends the first guest's key and order: refused, no pay URL or provider reference in the body, nothing created in either tenant", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const first = await payOrder(guest, order.id, "ewallet", "OV", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const url = first.body.data.redirectUrl as string;
    const foreignGuest = await other.newGuest();
    const mine = await intentCount(fx.tenant.tenantId);
    const theirs = await intentCount(other.tenant.tenantId);

    const res = await payOrder(
      foreignGuest,
      order.id,
      "ewallet",
      "OV",
      key,
      other,
    );

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(url);
    expect(text).not.toContain(first.body.data.id as string);
    expect(gw.created, "no second provider create").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(mine);
    expect(await intentCount(other.tenant.tenantId)).toBe(theirs);
    expect(
      (await intentRow(fx.tenant.tenantId, first.body.data.id)).status,
    ).toBe("pending");
  });

  it("legend-kis0u another table session of the same tenant sending the first guest's key (VA and e-wallet) is never given the first guest's payment", async () => {
    gw.reset();
    const a = await wholeOrder();
    const keyVa = randomUUID();
    const keyWallet = randomUUID();
    const va = await payOrder(a.guest, a.order.id, "va", "BC", keyVa);
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    // Swap away so the first VA is voided, then use a second bill for e-wallet.
    const swap = await payOrder(a.guest, a.order.id, "va", "I1", randomUUID());
    expect(swap.status, JSON.stringify(swap.body)).toBe(201);
    const b = await wholeOrder();
    const wallet = await payOrder(
      b.guest,
      b.order.id,
      "ewallet",
      "OV",
      keyWallet,
    );
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    const walletUrl = wallet.body.data.redirectUrl as string;
    const intruder = await wholeOrder();

    const stolenVa = await payOrder(
      intruder.guest,
      a.order.id,
      "va",
      "BC",
      keyVa,
    );
    const stolenWallet = await payOrder(
      intruder.guest,
      b.order.id,
      "ewallet",
      "OV",
      keyWallet,
    );

    for (const [res, victimId] of [
      [stolenVa, va.body.data.id],
      [stolenWallet, wallet.body.data.id],
    ] as const) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      const text = JSON.stringify(res.body);
      expect(text, "the victim's payment id is not handed over").not.toContain(
        victimId as string,
      );
      expect(text).not.toContain(walletUrl);
    }
    expect(
      (await intentRow(fx.tenant.tenantId, wallet.body.data.id)).status,
      "the victim's code is untouched",
    ).toBe("pending");
  });
});
