// legend-r7vxn: an unknown platform outcome (adapter threw) of a staff status
// step is resent by the worker sweep with backoff, up to
// PLATFORM_SYNC_MAX_ATTEMPTS calls; a refusal is never resent; staff see the
// state as `platformSync` on the order.
// Real PostgreSQL with RLS (disposable server from `pnpm test`); one fresh
// isolated tenant per test so sweep counts are exact. Rows are made due by
// passing a future `now` to the sweep, never by waiting.
//
// Assumptions (contract ambiguities):
// - The read API item is asserted through `toDeliveryChannelOrder(row)` on a
//   row read with the app role, not through an authenticated HTTP request.
// - Test 1 reads "down for 2 sweeps" as: the consumer call and the first sweep
//   call throw, the second sweep call succeeds.
// - After the cap is hit the row is `needs_action`; its `next_at` is not
//   asserted (the contract does not say).
import { randomUUID } from "node:crypto";
import { afterEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PoolClient } from "pg";
import { createUlid, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventFixture, type EventEnvelope } from "@starter/shared/events";
import { db as appDb } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliveryChannelOrders } from "../db/schema/delivery.ts";
import { setDeliveryChannelAdapter } from "../services/delivery-ports.ts";
import { deliverDeliveryChannelEvent } from "../services/delivery-sync-consumer.ts";
import { toDeliveryChannelOrder } from "../services/delivery-store.ts";
import {
  PLATFORM_SYNC_MAX_ATTEMPTS,
  retryDeliveryPlatformIntents,
} from "../services/delivery-platform-retry.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

type Tenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Status = "accepted" | "preparing";

const HOUR_MS = 60 * 60 * 1000;

// The lines check of the table needs at least one valid line (same shape as
// delivery-orders-api.test.ts seeds).
const ORDER_LINE = {
  lineNo: 1,
  externalItemId: "ext-kopi",
  externalItemName: "Kopi Susu",
  menuItemId: randomUUID(),
  variantId: null,
  quantity: 1,
  unitPriceIdr: 25_000,
  lineTotalIdr: 25_000,
  modifiers: [],
  note: null,
  mapping: "matched",
  channelPriceIdr: 25_000,
};

afterEach(() => setDeliveryChannelAdapter("gofood", null));
afterAll(async () => {
  setDeliveryChannelAdapter("gofood", null);
  await owner.end();
});

async function asOwnerTenant<T>(
  tenant: Tenant,
  run: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/** A fresh tenant with a GoFood channel and a way to seed orders and events. */
async function setup() {
  const tenant = await createIsolatedTenant(
    `r7vxn-${randomUUID().slice(0, 6)}`,
  );
  const tenantId = tenantIdSchema.parse(tenant.tenantId);
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  await asOwnerTenant(tenant, (db) =>
    db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, 'gofood', $3, 2000, true)`,
      [tenant.tenantId, tenant.outletId, `store-${randomUUID().slice(0, 8)}`],
    ),
  );

  // A platform order the staff just moved to `accepted`.
  const seedOrder = (): Promise<string> =>
    asOwnerTenant(tenant, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO delivery_channel_orders
           (tenant_id, outlet_id, platform, external_order_id, status, source,
            gross_idr, commission_idr, payload_hash, lines, received_at, accepted_at)
         VALUES ($1, $2, 'gofood', $3, 'accepted', 'platform', 25000, 5000, $4, $5, now(), now())
         RETURNING id`,
        [
          tenant.tenantId,
          tenant.outletId,
          `P-${randomUUID().slice(0, 8)}`,
          "a".repeat(64),
          JSON.stringify([ORDER_LINE]),
        ],
      );
      return rows[0]!.id;
    });

  let sequence = 0;
  const statusEvent = (orderId: string, to: Status): EventEnvelope =>
    ({
      ...eventFixture,
      id: createUlid(),
      tenantId,
      outletId: tenant.outletId,
      deviceId: null,
      name: "delivery_order.status_changed",
      aggregateType: "delivery_channel_order",
      aggregateId: orderId,
      sequence: ++sequence,
      idempotencyKey: `legend-r7vxn:${orderId}:${sequence}`,
      payloadSchemaRef: "delivery_order.status_changed.v1",
      payload: {
        deliveryChannelOrderId: orderId,
        platform: "gofood",
        externalOrderId: "GF-1",
        orderId: null,
        from: to === "accepted" ? "received" : "accepted",
        to,
        action: to === "accepted" ? "accept_order" : "update_order",
      },
    }) as EventEnvelope;

  const consume = (orderId: string, to: Status = "accepted") =>
    withTenant(appDb, context, (tx) =>
      deliverDeliveryChannelEvent(context, statusEvent(orderId, to), tx),
    );

  const sweep = (now: Date) => retryDeliveryPlatformIntents(context, now);

  const readSync = (orderId: string) =>
    asOwnerTenant(tenant, async (db) => {
      const { rows } = await db.query<{
        state: string;
        action: string | null;
        status: string | null;
        attempts: number;
        next_at: Date | null;
      }>(
        `SELECT platform_sync_state AS state, platform_sync_action AS action,
                platform_sync_status AS status, platform_sync_attempts AS attempts,
                platform_sync_next_at AS next_at
           FROM delivery_channel_orders WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, orderId],
      );
      return rows[0]!;
    });

  const desyncOutcomes = (orderId: string) =>
    asOwnerTenant(tenant, async (db) => {
      const { rows } = await db.query<{ outcome: string }>(
        `SELECT event->'maskedChanges'->'after'->>'outcome' AS outcome FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'delivery_order.platform_desync'`,
        [tenant.tenantId, orderId],
      );
      return rows.map((row) => row.outcome);
    });

  const readItem = (orderId: string) =>
    withTenant(appDb, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(deliveryChannelOrders)
        .where(eq(deliveryChannelOrders.id, orderId));
      return toDeliveryChannelOrder(row!);
    });

  return {
    seedOrder,
    consume,
    sweep,
    readSync,
    desyncOutcomes,
    readItem,
  };
}

type Behaviour = "accept" | "throw" | "refuse";

/** Installs a GoFood adapter whose answer is read per call; records references. */
function installAdapter(
  behaviour: () => Behaviour,
  delayMs = 0,
): { references: string[] } {
  const references: string[] = [];
  setDeliveryChannelAdapter("gofood", {
    execute: async (_context, input) => {
      references.push(input.reference);
      if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      const answer = behaviour();
      if (answer === "throw") throw new Error("platform down");
      return { reference: input.reference, accepted: answer === "accept" };
    },
  });
  return { references };
}

describe("legend-r7vxn delivery platform retry", () => {
  it("legend-r7vxn an unknown intent is resent by the sweep until success, then stops", async () => {
    const { seedOrder, consume, sweep, readSync, desyncOutcomes } =
      await setup();
    const orderId = await seedOrder();
    let calls = 0;
    // Consumer call and first sweep call fail; the second sweep call succeeds.
    const { references } = installAdapter(() =>
      ++calls <= 2 ? "throw" : "accept",
    );
    await consume(orderId);
    expect(await readSync(orderId)).toMatchObject({
      state: "retrying",
      action: "accept_order",
      status: "accepted",
      attempts: 1,
    });
    expect((await readSync(orderId)).next_at).toBeInstanceOf(Date);
    // The unknown outcome is still audited.
    expect(await desyncOutcomes(orderId)).toContain("unknown");

    const start = Date.now();
    expect(await sweep(new Date(start + HOUR_MS))).toBe(1);
    expect(await readSync(orderId)).toMatchObject({
      state: "retrying",
      attempts: 2,
    });
    expect(await sweep(new Date(start + 2 * HOUR_MS))).toBe(1);
    expect(await readSync(orderId)).toMatchObject({
      state: "ok",
      action: null,
      status: null,
      attempts: 0,
      next_at: null,
    });
    // Settled: nothing left to resend.
    expect(await sweep(new Date(start + 3 * HOUR_MS))).toBe(0);
    expect(references).toEqual(Array(3).fill(`${orderId}:accepted`));
  });

  it("legend-r7vxn the attempts cap stops resending after six platform calls and needs staff action", async () => {
    const { seedOrder, consume, sweep, readSync } = await setup();
    const orderId = await seedOrder();
    const { references } = installAdapter(() => "throw");
    await consume(orderId);
    expect((await readSync(orderId)).attempts).toBe(1);

    const start = Date.now();
    let round = 0;
    // Bounded loop: more rounds than the cap can ever need.
    while (
      (await readSync(orderId)).state === "retrying" &&
      round < PLATFORM_SYNC_MAX_ATTEMPTS + 4
    ) {
      round += 1;
      await sweep(new Date(start + round * 2 * HOUR_MS));
    }
    expect((await readSync(orderId)).state).toBe("needs_action");
    expect(references).toHaveLength(PLATFORM_SYNC_MAX_ATTEMPTS);
    expect(PLATFORM_SYNC_MAX_ATTEMPTS).toBe(6);

    // No further platform calls once staff action is needed.
    expect(await sweep(new Date(start + 100 * HOUR_MS))).toBe(0);
    expect(await sweep(new Date(start + 200 * HOUR_MS))).toBe(0);
    expect(references).toHaveLength(PLATFORM_SYNC_MAX_ATTEMPTS);
  });

  it("legend-r7vxn a refused intent is never resent", async () => {
    const { seedOrder, consume, sweep, readSync, desyncOutcomes } =
      await setup();
    const orderId = await seedOrder();
    const { references } = installAdapter(() => "refuse");
    await consume(orderId);
    expect(await readSync(orderId)).toMatchObject({
      state: "needs_action",
      next_at: null,
    });
    expect(await desyncOutcomes(orderId)).toEqual(["refused"]);
    expect(await sweep(new Date(Date.now() + 100 * HOUR_MS))).toBe(0);
    expect(references).toEqual([`${orderId}:accepted`]);
    expect((await readSync(orderId)).state).toBe("needs_action");
  });

  it("legend-r7vxn two sweeps at the same time call the platform once for a due row", async () => {
    const { seedOrder, consume, sweep, readSync } = await setup();
    const orderId = await seedOrder();
    let calls = 0;
    // The delay keeps the first sweep's call in flight while the second runs.
    const { references } = installAdapter(
      () => (++calls === 1 ? "throw" : "accept"),
      200,
    );
    await consume(orderId);
    expect(references).toHaveLength(1);

    const now = new Date(Date.now() + HOUR_MS);
    const [first, second] = await Promise.all([sweep(now), sweep(now)]);
    expect(first + second).toBe(1);
    // One call from the consumer, one from exactly one sweep.
    expect(references).toEqual(Array(2).fill(`${orderId}:accepted`));
    expect((await readSync(orderId)).state).toBe("ok");
  });

  it("legend-r7vxn a row that is not yet due is not resent", async () => {
    const { seedOrder, consume, sweep, readSync } = await setup();
    const orderId = await seedOrder();
    const { references } = installAdapter(() => "throw");
    await consume(orderId);
    // First backoff is minutes away; "now" is still before it.
    expect(await sweep(new Date())).toBe(0);
    expect(references).toHaveLength(1);
    expect(await readSync(orderId)).toMatchObject({
      state: "retrying",
      attempts: 1,
    });
  });

  it("legend-r7vxn a newer successful status intent clears the retrying state", async () => {
    const { seedOrder, consume, sweep, readSync } = await setup();
    const orderId = await seedOrder();
    let down = true;
    const { references } = installAdapter(() => (down ? "throw" : "accept"));
    await consume(orderId, "accepted");
    expect((await readSync(orderId)).state).toBe("retrying");

    down = false;
    await consume(orderId, "preparing");
    expect(await readSync(orderId)).toMatchObject({
      state: "ok",
      action: null,
      status: null,
      attempts: 0,
      next_at: null,
    });
    // Nothing pending anymore: the sweep does not resend the stale intent.
    expect(await sweep(new Date(Date.now() + 10 * HOUR_MS))).toBe(0);
    expect(references).toEqual([`${orderId}:accepted`, `${orderId}:preparing`]);
  });

  it("legend-r7vxn the order read carries platformSync ok, retrying and needs_action", async () => {
    const { seedOrder, consume, readItem } = await setup();
    const okOrder = await seedOrder();
    const retryingOrder = await seedOrder();
    const refusedOrder = await seedOrder();
    // An order with no pending step reads as ok.
    expect((await readItem(okOrder)).platformSync).toBe("ok");

    installAdapter(() => "throw");
    await consume(retryingOrder);
    expect((await readItem(retryingOrder)).platformSync).toBe("retrying");

    installAdapter(() => "refuse");
    await consume(refusedOrder);
    expect((await readItem(refusedOrder)).platformSync).toBe("needs_action");
  });
});
