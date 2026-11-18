// legend-gp3fw (brief 940, card B): a retry that carries the SAME idempotency
// key as a twin that committed a moment earlier must get the twin's intent back
// (replay), never a 409, never a second provider code, never a second intent.
//
// Window: retry reads "is there an intent for tenant + key?" (none), the twin
// commits its intent, then the retry's first guard (live code / hold / parked
// funds) sees the twin's live code and refuses with 409. Fix: when that guard
// refuses, read the key again. Found: same fingerprint -> replay; different
// fingerprint -> IDEMPOTENCY_KEY_REUSED; not found -> the guard's own 409.
//
// Written from the brief and the public payment contract, not from the code.
//
// Controlled concurrency (no sleeps for ordering):
//   1. a manual pg transaction INSERTs the twin intent (not committed, so the
//      retry cannot see it) and takes ACCESS EXCLUSIVE locks on the tables the
//      first guard reads (holds, parked funds, orders);
//   2. the retry is sent over HTTP: its key read finds nothing, then its guard
//      waits on one of the locked tables;
//   3. the test waits until a backend waits on a lock (or the request already
//      finished), then COMMITS: the twin and the guard see each other in that
//      order, which is the window.
// Without the fix the retry answers 409 ORDER_CODE_ACTIVE / SPLIT_CODE_ACTIVE.
//
// Assumptions (the brief does not fix them):
// - A replay answers 201 with the first intent's id (same as the existing
//   "a retried create with the same key returns the first intent" test).
// - Every table locked in step 1 is only a freezing point and a guess: the
//   first guard is expected to read at least one of them. If it reads none, the
//   retry is not frozen, passes the guard, asks the provider and waits on the
//   twin's unique key: the "no provider call" assertions then fail for a setup
//   reason. The fail-first run must show 409 ORDER_CODE_ACTIVE (not that).
// - Split part twin: bill_split_id of the part, the order's link, VA channel
//   "bmri", the key the guest path derives (qrs-<sha256(orderId:partId:key)
//   [0:48]>, form of orderId checked against a real probe code), and the part's
//   payer_secret_hash = sha256(secretFor(part)) set beforehand. The guest guard
//   runs BEFORE createIntentCore, so the split test freezes only on
//   payment_unallocated_funds (assumed read by createIntentCore's guard only).
// - Money: replay changes no amount; no parked funds row and no hold appear.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-940-gp3fw-replay.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { agent } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  bindLinkToOrder,
  expectRefusal,
  holdStates,
  intentRow,
  intentsOnLink,
  qrisBody,
  vaBody,
  type Pg,
} from "./qr-va-912-3p1-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const writerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

/** Tables the first guard may read; locked only to freeze the retry there. */
const FREEZE_TABLES = ["pos_qris_holds", "payment_unallocated_funds", "orders"];

type Twin = {
  linkId: string;
  key: string;
  method: "qris" | "va";
  amountIdr: number;
  billSplitId?: string | null;
};

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qr-va-940-gp3fw");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
}, 180_000);
afterAll(async () => {
  resetHoldPorts();
  await writerPool.end();
  await endPools();
});

async function insertLive(client: Pg, twin: Twin) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, bill_split_id, method, provider,
        provider_ref, amount_idr, idempotency_key, status, instructions, expires_at,
        channel_code)
     VALUES ($1, $2, $3, $4, $5, $6, 'doit', $7, $8, $9, 'pending', $10::jsonb,
             now() + interval '4 minutes', $11)`,
    [
      id,
      fx.tenant.tenantId,
      fx.tenant.outletId,
      twin.linkId,
      twin.billSplitId ?? null,
      twin.method,
      `TWIN-${id}`,
      twin.amountIdr,
      twin.key,
      JSON.stringify(
        twin.method === "qris"
          ? { method: "qris", qrPayload: "00020101021226TWINQR", issuer: null }
          : {
              method: "va",
              channelCode: "bmri",
              channelName: "Mandiri",
              virtualAccountNumber: "8808123456789012",
            },
      ),
      // A real VA row carries its bank in the column: the same-choice check
      // reads it (a seed without it would look like a bank change, Q15).
      twin.method === "va" ? "bmri" : null,
    ],
  );
  return id;
}

async function untilWaitingOrDone(isDone: () => boolean) {
  await vi.waitFor(
    async () => {
      if (isDone()) return;
      const { rows } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (rows[0]!.n === 0) throw new Error("request is not waiting yet");
    },
    { timeout: 30_000, interval: 50 },
  );
}

/**
 * Inserts the twins (uncommitted), freezes the guard, sends the retry, waits,
 * commits, and returns the retry's response and the twins' ids (same order).
 */
async function retryInWindow<T extends { status: number; body: unknown }>(
  twins: Twin[],
  send: () => PromiseLike<T>,
  freezeTables: string[] = FREEZE_TABLES,
) {
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
  try {
    await raw.query("BEGIN");
    await raw.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    const ids: string[] = [];
    for (const twin of twins)
      ids.push(await insertLive(raw as unknown as Pg, twin));
    await raw.query(
      `LOCK TABLE ${freezeTables.join(", ")} IN ACCESS EXCLUSIVE MODE`,
    );
    let done = false;
    const settled = Promise.resolve(send()).then(
      (response) => {
        done = true;
        return response;
      },
      (error: unknown) => {
        done = true;
        throw error;
      },
    );
    await untilWaitingOrDone(() => done);
    await finish("COMMIT");
    return { response: await settled, ids };
  } finally {
    await finish("ROLLBACK");
  }
}

async function bill() {
  const order = await newSubmittedOrder(fx, 0);
  const { token, linkId } = await bindLinkToOrder(fx, order);
  return { order, orderUuid: ulidToUuid(order.id), token, linkId };
}

/** Nothing moved: no hold, no parked money, intents have the bill's amount. */
async function expectNoMoneyChange(b: Awaited<ReturnType<typeof bill>>) {
  expect(await holdStates(fx.tenant.tenantId, b.orderUuid)).toEqual([]);
  expect(await unallocatedFunds(fx)).toEqual([]);
  const { rows } = await owner.query<{ amount_idr: number }>(
    "SELECT amount_idr::int AS amount_idr FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2",
    [fx.tenant.tenantId, b.linkId],
  );
  for (const row of rows) expect(row.amount_idr).toBe(b.order.totalIdr);
}

describe("legend-gp3fw: a twin with the same key commits between the key read and the first guard", () => {
  it("legend-gp3fw token call replays the twin's intent 201, asks the provider for nothing, stores no second intent", async () => {
    const b = await bill();
    const key = randomUUID();
    const providerCalls = fx.gateway.requests.length;

    const { response, ids } = await retryInWindow(
      [{ linkId: b.linkId, key, method: "qris", amountIdr: b.order.totalIdr }],
      () =>
        agent(fx.app)
          .post(`/api/payments/links/${b.token}/intents`)
          .send(qrisBody(key)),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((response.body as { data: { id: string } }).data.id).toBe(ids[0]);
    expect(
      fx.gateway.requests.length,
      "the replay asks the provider for no second code",
    ).toBe(providerCalls);
    expect(
      await intentsOnLink(fx.tenant.tenantId, b.linkId),
      "exactly one intent for the key",
    ).toEqual([ids[0]]);
    expect((await intentRow(fx.tenant.tenantId, ids[0]!)).status).toBe(
      "pending",
    );
    await expectNoMoneyChange(b);
  });

  it("legend-gp3fw the same key with another method is refused 409 IDEMPOTENCY_KEY_REUSED, not the guard's ORDER_CODE_ACTIVE, and the twin stays the only intent", async () => {
    const b = await bill();
    const key = randomUUID();
    const providerCalls = fx.gateway.requests.length;

    const { response, ids } = await retryInWindow(
      [{ linkId: b.linkId, key, method: "qris", amountIdr: b.order.totalIdr }],
      () =>
        agent(fx.app)
          .post(`/api/payments/links/${b.token}/intents`)
          .send(vaBody(key)),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(
      (response.body as { error?: { code?: string } }).error?.code,
      JSON.stringify(response.body),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(fx.gateway.requests.length).toBe(providerCalls);
    expect(await intentsOnLink(fx.tenant.tenantId, b.linkId)).toEqual([ids[0]]);
    await expectNoMoneyChange(b);
  });

  it("legend-gp3fw the same key already used on another link is refused 409 IDEMPOTENCY_KEY_REUSED, not replayed onto this link", async () => {
    const own = await bill();
    const other = await bill();
    const key = randomUUID();
    const providerCalls = fx.gateway.requests.length;

    // `own` holds a live code of its own (so its guard refuses); the key itself
    // belongs to the twin on `other`.
    const { response, ids } = await retryInWindow(
      [
        {
          linkId: own.linkId,
          key: randomUUID(),
          method: "qris",
          amountIdr: own.order.totalIdr,
        },
        {
          linkId: other.linkId,
          key,
          method: "qris",
          amountIdr: other.order.totalIdr,
        },
      ],
      () =>
        agent(fx.app)
          .post(`/api/payments/links/${own.token}/intents`)
          .send(qrisBody(key)),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(
      (response.body as { error?: { code?: string } }).error?.code,
      JSON.stringify(response.body),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(fx.gateway.requests.length).toBe(providerCalls);
    expect(await intentsOnLink(fx.tenant.tenantId, own.linkId)).toEqual([
      ids[0],
    ]);
    expect(await intentsOnLink(fx.tenant.tenantId, other.linkId)).toEqual([
      ids[1],
    ]);
  });
});

describe("legend-gp3fw: the guard's own refusal stays", () => {
  it("legend-gp3fw a DIFFERENT key while a live code exists is still 409 ORDER_CODE_ACTIVE, no provider call, no new intent", async () => {
    const b = await bill();
    const first = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(vaBody());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const providerCalls = fx.gateway.requests.length;

    const refused = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(vaBody());

    expectRefusal(refused, "ORDER_CODE_ACTIVE");
    expect(fx.gateway.requests.length).toBe(providerCalls);
    expect(await intentsOnLink(fx.tenant.tenantId, b.linkId)).toEqual([
      first.body.data.id,
    ]);
    await expectNoMoneyChange(b);
  });

  it("legend-gp3fw a live code written by another key while the call waits is still 409 ORDER_CODE_ACTIVE (key not found on re-read), no new intent", async () => {
    const b = await bill();
    const providerCalls = fx.gateway.requests.length;

    const { response, ids } = await retryInWindow(
      [
        {
          linkId: b.linkId,
          key: randomUUID(),
          method: "va",
          amountIdr: b.order.totalIdr,
        },
      ],
      () =>
        agent(fx.app)
          .post(`/api/payments/links/${b.token}/intents`)
          .send(vaBody(randomUUID())),
    );

    expectRefusal(response, "ORDER_CODE_ACTIVE");
    expect(fx.gateway.requests.length).toBe(providerCalls);
    expect(await intentsOnLink(fx.tenant.tenantId, b.linkId)).toEqual([ids[0]]);
    await expectNoMoneyChange(b);
  });

  it("legend-gp3fw a plain retry (no race) with the same key and body still replays 201 with one intent and one provider call", async () => {
    const b = await bill();
    const key = randomUUID();
    const providerCalls = fx.gateway.requests.length;

    const first = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody(key));
    const second = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody(key));

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(fx.gateway.requests.length).toBe(providerCalls + 1);
    expect(await intentsOnLink(fx.tenant.tenantId, b.linkId)).toEqual([
      first.body.data.id,
    ]);
  });
});
