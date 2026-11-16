// legend-154wr (brief docs/briefs/912-3p1.md, Putaran 3, part B): the window
// between "check for a hold or an active code" and "write the new intent" is
// closed in the database. A writer that already holds the order row (a QRIS
// hold or a live code opened in a transaction that is not committed yet) makes
// the public token call wait; when the writer commits, the call sees the hold
// or the code and answers 409 and stores no intent.
//
// Written from the brief and the public payment contract, not from the code.
//
// Deterministic, no sleeps for ordering:
//   1. a manual pg transaction locks the order row and inserts a hold (or a
//      live code), not committed;
//   2. POST /api/payments/links/:token/intents is sent over HTTP: it passes the
//      first check (the uncommitted row is invisible) and then waits on the
//      order row lock;
//   3. the test waits until the request is waiting on a lock (pg_stat_activity)
//      OR has already finished, then commits the writer.
// Without the order row lock the request does not wait: it finishes at step 3
// with 201 and an intent stored, and the test fails on the 409 assertion.
//
// Assumptions:
// - The order lock is on the `orders` row, so a writer that locks that row
//   (SELECT ... FOR UPDATE) is what the request must wait for.
// - The waiting call is a backend with wait_event_type 'Lock' in the test
//   database. Another backend waiting for a lock would only make step 3 run
//   earlier (the check then catches the hold at the first check): a weaker
//   test, never a false failure.
// - The request may already have asked the provider for a code before it waits
//   (the first check passed), so the provider call count is not asserted here;
//   only the stored intents and the hold/code rows are.
// - Recovery charge race is not covered (brief: "bila murah").
// - The last describe is a no-self-deadlock control for callers that already
//   hold the order lock themselves (cashier QRIS tender, guest split part).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-912-154wr-race.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { agent } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  bindLinkToOrder,
  expectHoldRefusal,
  expectRefusal,
  holdStates,
  intentRow,
  intentsOnLink,
  qrisBody,
  seedHeldCode,
  seedLiveCode,
  vaBody,
  type Pg,
} from "./qr-va-912-3p1-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  holdFixture,
  issueQris,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** One connection for the manual writer transaction. */
const writerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

type Writer = {
  client: Pg;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

/** BEGIN, tenant settings, lock the order row. Nothing written yet. */
async function lockOrderAsWriter(
  tenantId: string,
  orderUuid: string,
): Promise<Writer> {
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
      [tenantId],
    );
    await raw.query(
      "SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, orderUuid],
    );
  } catch (error) {
    await finish("ROLLBACK");
    throw error;
  }
  return {
    client: raw as unknown as Pg,
    commit: () => finish("COMMIT"),
    rollback: () => finish("ROLLBACK"),
  };
}

/** Resolves when a backend waits on a lock, or `isDone()` turns true. */
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

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qr-va-912-154wr");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
}, 180_000);
afterAll(async () => {
  resetHoldPorts();
  await writerPool.end();
  await endPools();
});

/** A bill with a token. The order row is the lock the request must wait for. */
async function bill() {
  const order = await newSubmittedOrder(fx, 0);
  const { token, linkId } = await bindLinkToOrder(fx, order);
  return { order, orderUuid: ulidToUuid(order.id), token, linkId };
}

/**
 * Locks the order, lets `write` add rows, sends the token request, waits until
 * it waits (or finished), commits, and returns the response.
 */
async function raceWith(
  b: Awaited<ReturnType<typeof bill>>,
  body: Record<string, unknown>,
  write: (writer: Writer) => Promise<unknown>,
) {
  const writer = await lockOrderAsWriter(fx.tenant.tenantId, b.orderUuid);
  try {
    await write(writer);
    let done = false;
    const settled = agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(body)
      .then(
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
    await writer.commit();
    return await settled;
  } finally {
    await writer.rollback();
  }
}

describe("legend-154wr: a hold or a live code committed while the token call waits", () => {
  it("legend-154wr a QRIS hold opened in an uncommitted transaction refuses the token call 409 QRIS_HOLD_ACTIVE and no intent is stored", async () => {
    const b = await bill();
    const tenantId = fx.tenant.tenantId;
    const seeded: { intentId?: string } = {};

    const response = await raceWith(b, qrisBody(), async (writer) => {
      const held = await seedHeldCode(writer.client, {
        tenantId,
        outletId: fx.tenant.outletId,
        orderUuid: b.orderUuid,
        amountIdr: b.order.totalIdr,
      });
      seeded.intentId = held.intentId;
    });

    expectHoldRefusal(response);
    expect(
      await intentsOnLink(tenantId, b.linkId),
      "no intent stored on the bill's link",
    ).toEqual([]);
    expect(await holdStates(tenantId, b.orderUuid)).toEqual(["open"]);
    expect(
      (await intentRow(tenantId, seeded.intentId!)).status,
      "the held code is left pending",
    ).toBe("pending");
  });

  it("legend-154wr a live code written in an uncommitted transaction refuses the token call 409 ORDER_CODE_ACTIVE and no intent is stored", async () => {
    const b = await bill();
    const tenantId = fx.tenant.tenantId;
    let liveId = "";

    const response = await raceWith(b, vaBody(), async (writer) => {
      liveId = await seedLiveCode(writer.client, {
        tenantId,
        outletId: fx.tenant.outletId,
        linkId: b.linkId,
        amountIdr: b.order.totalIdr,
        method: "va",
      });
    });

    expectRefusal(response, "ORDER_CODE_ACTIVE");
    expect(await intentsOnLink(tenantId, b.linkId)).toEqual([liveId]);
    expect((await intentRow(tenantId, liveId)).status).toBe("pending");
  });

  it("legend-154wr control: the order lock is held with nothing written, the call waits and then issues a code 201", async () => {
    const b = await bill();
    const tenantId = fx.tenant.tenantId;

    const response = await raceWith(b, qrisBody(), async () => undefined);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await intentsOnLink(tenantId, b.linkId)).toEqual([
      response.body.data.id,
    ]);
  });
});

describe("legend-154wr control: callers that already hold the order lock do not deadlock on themselves", () => {
  it("legend-154wr cashier QRIS tender on a POS bill still issues its code 201", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.response.status, JSON.stringify(qr.response.body)).toBe(201);
    expect((await intentRow(fx.tenant.tenantId, qr.intentId)).status).toBe(
      "pending",
    );
  });

  it("legend-154wr guest split part paid by VA still issues its code 201", async () => {
    const guest = await fx.newGuest();
    await fx.qrOrder(guest);
    const split = await fx.guestPost(guest, "/splits", {
      method: "equal",
      parts: 2,
      idempotencyKey: randomUUID(),
    });
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const part = (split.body.data.splits as { id: string }[])[0]!;

    const paid = await fx.guestPost(guest, "/payments", {
      target: { kind: "split", billSplitId: part.id },
      method: "va",
      payerSecret: secretFor(part.id),
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  });
});
