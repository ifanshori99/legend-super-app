// legend-1146 (second opinion on 1130 P2): the breakfast payment consumer must
// not wait on the payment provider while it holds the outbox row and offset
// row locks of `consumeOutbox`. Written from the second-opinion brief and the
// public contract (consumeOutbox + deliverOrderPaymentEvent), not from the
// consumer implementation. Real app, Better Auth, payment service, PostgreSQL;
// only the gateway is a scripted double, extended here so a status read can be
// held open by the test.
//
// Run: LEGEND_TEST_FILES="src/test/facility-breakfast-consumer-proof-lock-1146.test.ts" heavy pnpm test
//
// Rules under test:
//  - A VALID payment (code A covers the bill, ticket alive, order awaiting)
//    never asks the provider about the other open code (B): the order is paid
//    and consumed while the provider answer for B is still pending.
//  - A REFUSED payment (late: ticket ended) asks the provider, but only OUTSIDE
//    the consume transaction: while the answer is pending another connection
//    can lock the outbox row and the offset row (no lock is held).
//  - Money the provider holds for B is returned exactly once (A and B each
//    once, never above received); unclear answers never cancel or refund, the
//    hold surfaces as 409 PAYMENT_PROVIDER_UNCONFIRMED and a later clear answer
//    completes the cancel with one refund.
//
// Assumptions where the brief is silent:
// - `consumeWithProof` wraps `consumeOutbox` in the real
//   `withBreakfastProviderProof`; its deliver passes `{ breakfastProviderProven }`
//   as 5th argument of `deliverOrderPaymentEvent`. At the base commit the
//   consumer asked the provider itself inside the transaction, which is what
//   these tests catch.
// - Same scenario as BRK-FIREPROV: B is the guest's older open QR code of the
//   same link; A is scripted "00" (paid) so the world is coherent.
// - The event is consumed by driving its first outbox row (any destination)
//   through `consumeOutbox`; the test only pre-creates the offset row so the
//   sequence check passes (the lock assertions need the offset row to exist
//   before the transaction starts).
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withBreakfastProviderProof } from "../services/facility-breakfast-consumers.ts";
import { consumeOutbox } from "../services/core-outbox.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  asOwnerTenant,
  createBreakfastWorld,
  deliver,
  dropBreakfastWorld,
  endPools,
  linkedOf,
  newMember,
  openIntent,
  openSecondIntent,
  paidEvent,
  payLink,
  placeOrder,
  seedTicket,
  settle,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import {
  expectUnconfirmedError,
  moneyOfIntent,
  paidEventsOf,
  settleCall,
  type IntentMoney,
} from "./payment-link-cancel-provider-helpers.ts";
import { ScriptedGateway } from "./pos-qris-hold-test-helpers.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** A scripted provider whose status read for one intent can be held open. */
class HoldingGateway extends ScriptedGateway {
  private readonly intentOfRef = new Map<string, string>();
  private readonly holds = new Map<
    string,
    { asked: Deferred; release: Deferred }
  >();

  /** The next status reads of `intentId` start, then wait until `release()`. */
  hold(intentId: string) {
    const asked = deferred();
    const release = deferred();
    this.holds.set(intentId, { asked, release });
    return {
      asked: asked.promise,
      release: release.resolve,
    };
  }

  override async createIntent(
    ...args: Parameters<ScriptedGateway["createIntent"]>
  ) {
    const created = await super.createIntent(...args);
    this.intentOfRef.set(created.providerRef, args[0].intentId);
    return created;
  }

  override async getStatus(input: { providerRef: string; intentId?: string }) {
    const intentId = input.intentId ?? this.intentOfRef.get(input.providerRef);
    const hold = intentId ? this.holds.get(intentId) : undefined;
    if (hold) {
      hold.asked.resolve();
      await hold.release.promise;
    }
    return super.getStatus(input);
  }
}

let app: Express;
let world: BreakfastWorld;
let gateway: HoldingGateway;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  world = await createBreakfastWorld(app);
  gateway = new HoldingGateway("doit");
  setPaymentGateway(gateway);
});

afterAll(async () => {
  setPaymentGateway(null);
  await dropBreakfastWorld(world);
  await endPools();
});

type Setup = Awaited<ReturnType<typeof twoCodes>>;

/** An awaiting_payment order whose guest opened two QR codes (A then B). */
async function twoCodes() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);
  const a = await openIntent(world, token);
  const b = await openSecondIntent(world, token);
  expect(b.id).not.toBe(a.id);
  gateway.script(a.id, { rawStatus: "00", amountIdr: order.totalIdr });
  return { ticketId, order, a, b, total: order.totalIdr };
}

/** Code A paid in time: the consumer has a valid payment to apply. */
async function validPayment() {
  const setup = await twoCodes();
  await settle(world, setup.a.id, setup.total);
  return { ...setup, event: await paidEvent(world, setup.a.id) };
}

/** Code A paid at the provider but the ticket ended before the notice arrived. */
async function latePayment() {
  const setup = await validPayment();
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE access_tickets
          SET ends_at = now() - interval '1 minute',
              cleaning_ends_at = now() + interval '9 minutes'
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(setup.ticketId)],
    ),
  );
  expect((await linkedOf(world, setup.order.id)).status).toBe(
    "awaiting_payment",
  );
  return setup;
}

type OutboxRow = {
  id: string;
  destination: string;
  aggregateId: string;
  generation: number;
};

/** The first outbox row of the event, with its offset row created up front. */
async function outboxRowOf(event: EventEnvelope): Promise<OutboxRow> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      destination: string;
      aggregate_id: string;
      dispatch_generation: string;
    }>(
      `SELECT id, destination, aggregate_id, dispatch_generation
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'id' = $2
        ORDER BY created_at, id LIMIT 1`,
      [world.tenant.tenantId, event.id],
    );
    const row = rows[0];
    if (!row) throw new Error("No outbox row for the payment.paid event");
    await client.query(
      `INSERT INTO domain_event_offsets (tenant_id, outlet_id, consumer, aggregate_type, aggregate_id)
       VALUES ($1, $2, $3, $4, $5::uuid) ON CONFLICT DO NOTHING`,
      [
        world.tenant.tenantId,
        event.outletId,
        row.destination,
        event.aggregateType,
        row.aggregate_id,
      ],
    );
    await client.query(
      `UPDATE domain_event_offsets SET last_sequence = $4
        WHERE consumer = $1 AND aggregate_type = $2 AND aggregate_id = $3::uuid`,
      [
        row.destination,
        event.aggregateType,
        row.aggregate_id,
        event.sequence - 1,
      ],
    );
    return {
      id: row.id,
      destination: row.destination,
      aggregateId: row.aggregate_id,
      generation: Number(row.dispatch_generation),
    };
  });
}

/** `consumeOutbox` of the event's row, with the provider proof round trip. */
function consumeWithProof(row: OutboxRow, now = new Date()): Promise<boolean> {
  return withBreakfastProviderProof(
    world.context,
    (breakfastProviderProven) =>
      consumeOutbox(db, world.context, {
        outboxId: uuidToUlid(row.id),
        generation: row.generation,
        authorize: async () => true,
        deliver: async (event, _key, tx) => {
          await deliverOrderPaymentEvent(world.context, event, tx, now, {
            breakfastProviderProven,
          });
        },
      }),
    now,
  );
}

async function consumedCount(row: OutboxRow, event: EventEnvelope) {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_event_consumptions
        WHERE consumer = $1 AND event_id = $2::uuid`,
      [row.destination, ulidToUuid(event.id)],
    );
    return rows[0]!.n;
  });
}

/** From ANOTHER connection: can the outbox row and the offset row be locked now? */
async function lockProbe(row: OutboxRow, event: EventEnvelope) {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    try {
      await client.query(
        `SELECT 1 FROM domain_event_outbox WHERE id = $1::uuid FOR UPDATE NOWAIT`,
        [row.id],
      );
      await client.query(
        `SELECT 1 FROM domain_event_offsets
          WHERE consumer = $1 AND aggregate_type = $2 AND aggregate_id = $3::uuid
            FOR UPDATE NOWAIT`,
        [row.destination, event.aggregateType, row.aggregateId],
      );
      return null;
    } catch (error) {
      return error as { code?: string; message: string };
    }
  });
}

async function moneyOf(setup: Setup) {
  return {
    a: await moneyOfIntent(world.tenant.tenantId, setup.a.id),
    b: await moneyOfIntent(world.tenant.tenantId, setup.b.id),
  };
}

const returnedOf = (money: IntentMoney) =>
  Math.max(money.refundsIdr, money.parkedIdr);

/** The provider's notices for B reach the consumer, replayed. */
async function deliverNoticesOfB(setup: Setup) {
  for (const event of await paidEventsOf(world.tenant.tenantId, setup.b.id))
    for (let i = 0; i < 2; i += 1) await deliver(world, event);
}

describe("legend-1146 BRK-PROOFLOCK breakfast consumer never waits on the provider under the consume locks", () => {
  it("BRK-PROOFLOCK-01 valid payment, provider answer for the other code still pending -> order paid and consumed, provider never asked", async () => {
    const setup = await validPayment();
    const row = await outboxRowOf(setup.event);
    const hold = gateway.hold(setup.b.id);

    const consuming = consumeWithProof(row);
    consuming.catch(() => undefined);
    const first = await Promise.race([
      consuming.then(() => "consumed" as const),
      hold.asked.then(() => "asked-provider" as const),
    ]);
    hold.release();
    await consuming;

    expect(
      first,
      "a good payment waited on the provider about the other open code",
    ).toBe("consumed");
    const linked = await linkedOf(world, setup.order.id);
    expect(linked.status).toBe("paid");
    expect(linked.cancelledAt).toBeNull();
    expect(await consumedCount(row, setup.event)).toBe(1);
    const money = await moneyOf(setup);
    expect(money.a.refundCount + money.a.fundCount).toBe(0);
    expect(money.b.refundCount + money.b.fundCount).toBe(0);
  });

  it("BRK-PROOFLOCK-02 refused late payment, provider answer pending -> outbox row and offset row are lockable from another connection, order untouched meanwhile", async () => {
    const setup = await latePayment();
    const row = await outboxRowOf(setup.event);
    gateway.script(setup.b.id, { rawStatus: "01" });
    const hold = gateway.hold(setup.b.id);

    const consuming = consumeWithProof(row);
    consuming.catch(() => undefined);
    const first = await Promise.race([
      hold.asked.then(() => "asked-provider" as const),
      consuming.then(() => "finished-without-asking" as const),
    ]);
    let lockError: { code?: string; message: string } | null = null;
    let whilePending = "";
    try {
      if (first === "asked-provider") {
        lockError = await lockProbe(row, setup.event);
        whilePending = (await linkedOf(world, setup.order.id)).status;
      }
    } finally {
      hold.release();
    }
    await consuming;

    expect(first, "the refused payment never asked the provider").toBe(
      "asked-provider",
    );
    expect(
      lockError?.message ?? null,
      "outbox/offset row still locked while the provider answer is pending",
    ).toBeNull();
    expect(whilePending).toBe("awaiting_payment");
  });

  it("BRK-PROOFLOCK-03 refused late payment, provider says the other code is unpaid -> cancelled, A refunded once in full, B has no money, replay changes nothing", async () => {
    const setup = await latePayment();
    const row = await outboxRowOf(setup.event);
    gateway.script(setup.b.id, { rawStatus: "01" });

    expect(await consumeWithProof(row)).toBe(true);
    expect(await consumeWithProof(row)).toBe(false);

    const linked = await linkedOf(world, setup.order.id);
    expect(linked.status).toBe("cancelled");
    const money = await moneyOf(setup);
    expect(money.a.refundCount).toBe(1);
    expect(returnedOf(money.a)).toBe(setup.total);
    expect(money.b.refundCount + money.b.fundCount).toBe(0);
    expect(
      gateway.readsOf(setup.b.id).length,
      "provider never asked about the other open code",
    ).toBeGreaterThanOrEqual(1);
  });

  it("BRK-PROOFLOCK-04 refused late payment, provider already holds B's money -> cancelled, A and B each returned exactly once, never above received", async () => {
    const setup = await latePayment();
    const row = await outboxRowOf(setup.event);
    gateway.script(setup.b.id, { rawStatus: "00", amountIdr: setup.total });
    const hold = gateway.hold(setup.b.id);

    const consuming = consumeWithProof(row);
    consuming.catch(() => undefined);
    await Promise.race([hold.asked, consuming.then(() => undefined)]);
    hold.release();
    await consuming;
    await deliverNoticesOfB(setup);
    await consumeWithProof(row);

    expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    const money = await moneyOf(setup);
    for (const [name, m] of [
      ["A", money.a],
      ["B", money.b],
    ] as const) {
      expect(m.refundCount, `${name} refunded twice`).toBeLessThanOrEqual(1);
      expect(m.fundCount, `${name} parked twice`).toBeLessThanOrEqual(1);
      expect(returnedOf(m), `${name} above received`).toBeLessThanOrEqual(
        setup.total,
      );
    }
    expect(returnedOf(money.a), "A returned in full").toBe(setup.total);
    expect(returnedOf(money.b), "B returned in full").toBe(setup.total);
  });

  it("BRK-PROOFLOCK-05 refused late payment, unclear provider answer -> 409 PAYMENT_PROVIDER_UNCONFIRMED, order untouched, nothing refunded or consumed; a clear answer later cancels with one refund", async () => {
    const setup = await latePayment();
    const row = await outboxRowOf(setup.event);
    gateway.script(setup.b.id, { error: "timeout" });

    const result = await settleCall(consumeWithProof(row));

    expectUnconfirmedError(result, "unclear answer");
    const linked = await linkedOf(world, setup.order.id);
    expect(linked.status).toBe("awaiting_payment");
    expect(linked.cancelledAt).toBeNull();
    expect(await consumedCount(row, setup.event)).toBe(0);
    const held = await moneyOf(setup);
    expect(held.a.refundCount + held.a.fundCount).toBe(0);
    expect(held.b.refundCount + held.b.fundCount).toBe(0);

    gateway.script(setup.b.id, { rawStatus: "01" });
    expect(await consumeWithProof(row)).toBe(true);
    expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    const money = await moneyOf(setup);
    expect(money.a.refundCount).toBe(1);
    expect(returnedOf(money.a)).toBe(setup.total);
    expect(money.b.refundCount + money.b.fundCount).toBe(0);
  });
});
