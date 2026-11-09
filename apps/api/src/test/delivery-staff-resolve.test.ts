// legend-eyqvo: staff resend / resolve of a delivery order whose platform sync
// is `needs_action` (contract: packages/shared/src/delivery/endpoints.ts,
// POST .../delivery-orders/:id/platform-sync/resend and /resolve, gate
// `delivery.order.handle`). Real Express app, Better Auth, RBAC and PostgreSQL
// with RLS (disposable server from `pnpm test`); one fresh isolated tenant per
// test so sweep call counts are exact.
//
// Assumptions (contract ambiguities):
// - Everything goes through HTTP + the public sweep (retryDeliveryPlatformIntents);
//   the service functions are not imported, so only the contract is tested.
// - A `needs_action` row is seeded directly: state needs_action, action
//   accept_order, status accepted, attempts 6 (cap hit), next_at null.
// - Audit actor/reason/timestamp are read from the stored audit event as
//   `actorType`, `actorId`, `reason` (or anywhere in the event JSON) and
//   `createdAt`.
// - An extra body key is rejected with 422 (brief), an untrusted Origin with 403.
// - The concurrency test starts the second resend while the first one's
//   platform call is in flight, then lets both finish: exactly one 200 and one
//   409, one adapter call.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { deliveryChannelOrderSchema } from "@starter/shared/delivery";
import { createApp } from "../app.ts";
import { setDeliveryChannelAdapter } from "../services/delivery-ports.ts";
import { retryDeliveryPlatformIntents } from "../services/delivery-platform-retry.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seedTenantOutlets,
} from "./floor-test-helpers.ts";

type Tenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Client = ReturnType<typeof agent>;
type SyncState = "needs_action" | "ok" | "retrying";

const HOUR_MS = 60 * 60 * 1000;
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

let app: Express;

beforeAll(() => {
  app = createApp();
});
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

async function staffUser(
  tenant: Tenant,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [
      roleId,
      tenant.tenantId,
      `Role ${roleId.slice(0, 6)}`,
      JSON.stringify(permissions),
    ],
  );
  const client = agent(app);
  await signUp(client, "Delivery Staff");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId };
}

/** A fresh tenant with outlets A and B, a GoFood channel each, and three users. */
async function setup() {
  const tenant = await createIsolatedTenant(
    `eyqvo-${randomUUID().slice(0, 6)}`,
  );
  const [outletB] = await seedTenantOutlets(tenant.tenantId, 1);
  const outletA = tenant.outletId;
  for (const outletId of [outletA, outletB!])
    await asOwnerTenant(tenant, (db) =>
      db.query(
        `INSERT INTO delivery_channels
           (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
         VALUES ($1, $2, 'gofood', $3, 2000, true)`,
        [tenant.tenantId, outletId, `store-${randomUUID().slice(0, 8)}`],
      ),
    );
  // Handler at outlet A only; handler at tenant scope; user without the gate.
  const handlerA = await staffUser(tenant, ["delivery.order.handle"], {
    type: "outlet",
    outletId: outletA,
  });
  const noGate = await staffUser(tenant, ["floor.table.view"], {
    type: "tenant",
  });

  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  const sweep = (now: Date) => retryDeliveryPlatformIntents(context, now);

  const seedOrder = (
    state: SyncState,
    outletId: string = outletA,
  ): Promise<string> =>
    asOwnerTenant(tenant, async (db) => {
      const held = state !== "ok";
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO delivery_channel_orders
           (tenant_id, outlet_id, platform, external_order_id, status, source,
            gross_idr, commission_idr, payload_hash, lines, received_at, accepted_at,
            platform_sync_state, platform_sync_action, platform_sync_status,
            platform_sync_attempts, platform_sync_next_at)
         VALUES ($1, $2, 'gofood', $3, 'accepted', 'platform', 25000, 5000, $4, $5, now(), now(),
                 $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          tenant.tenantId,
          outletId,
          `P-${randomUUID().slice(0, 8)}`,
          "a".repeat(64),
          JSON.stringify([ORDER_LINE]),
          state,
          held ? "accept_order" : null,
          held ? "accepted" : null,
          state === "needs_action" ? 6 : held ? 1 : 0,
          state === "retrying" ? new Date(Date.now() + HOUR_MS) : null,
        ],
      );
      return rows[0]!.id;
    });

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

  const auditEvents = (orderId: string, action: string) =>
    asOwnerTenant(tenant, async (db) => {
      const { rows } = await db.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
        [tenant.tenantId, orderId, action],
      );
      return rows.map((row) => row.event);
    });

  const url = (outletId: string, orderId: string, action: string) =>
    `/api/outlets/${encodeURIComponent(outletId)}/delivery-orders/${encodeURIComponent(orderId)}/platform-sync/${action}`;

  const call = (
    client: Client,
    action: "resend" | "resolve",
    orderId: string,
    options: {
      outletId?: string;
      body?: Record<string, unknown>;
      origin?: string;
    } = {},
  ) =>
    client
      .post(url(options.outletId ?? outletA, orderId, action))
      .set({ Host: tenant.hostname })
      .set(options.origin ? { Origin: options.origin } : originHeader)
      .set("Idempotency-Key", randomUUID())
      .send(options.body ?? {});

  return {
    tenant,
    outletA,
    outletB: outletB!,
    handlerA,
    noGate,
    sweep,
    seedOrder,
    readSync,
    auditEvents,
    call,
  };
}

type Behaviour = "accept" | "throw" | "refuse";

/** A GoFood adapter whose answer is read per call; `gate` holds the call open. */
function installAdapter(
  behaviour: () => Behaviour,
  gate?: Promise<void>,
): { references: string[] } {
  const references: string[] = [];
  setDeliveryChannelAdapter("gofood", {
    execute: async (_context, input) => {
      references.push(input.reference);
      if (gate) await gate;
      const answer = behaviour();
      if (answer === "throw") throw new Error("platform down");
      return { reference: input.reference, accepted: answer === "accept" };
    },
  });
  return { references };
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

async function waitUntil(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("legend-eyqvo staff resend of a needs_action order", () => {
  it("legend-eyqvo resend accepted by the platform: sync ok, intent cleared, audited with the actor", async () => {
    const { handlerA, seedOrder, readSync, auditEvents, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const { references } = installAdapter(() => "accept");

    const res = await call(handlerA.client, "resend", orderId, { body: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const order = deliveryChannelOrderSchema.parse(res.body.data);
    expect(order.id).toBe(orderId);
    expect(order.platformSync).toBe("ok");
    expect(await readSync(orderId)).toMatchObject({
      state: "ok",
      action: null,
      status: null,
      attempts: 0,
      next_at: null,
    });
    expect(references).toEqual([`${orderId}:accepted`]);

    const events = await auditEvents(orderId, "delivery_order.platform_resend");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "user",
      actorId: handlerA.userId,
    });
    expect(
      (events[0]!.maskedChanges as { after?: { outcome?: string } }).after
        ?.outcome,
    ).toBe("accepted");
  });

  it("legend-eyqvo resend refused by the platform: still needs_action, no backoff restart, sweep never resends", async () => {
    const { handlerA, seedOrder, readSync, sweep, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const { references } = installAdapter(() => "refuse");

    const res = await call(handlerA.client, "resend", orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.platformSync).toBe("needs_action");
    expect(await readSync(orderId)).toMatchObject({
      state: "needs_action",
      next_at: null,
    });
    expect(references).toEqual([`${orderId}:accepted`]);

    expect(await sweep(new Date(Date.now() + 100 * HOUR_MS))).toBe(0);
    expect(references).toHaveLength(1);
  });

  it("legend-eyqvo resend when the platform call throws (unknown): still needs_action, sweep never resends", async () => {
    const { handlerA, seedOrder, readSync, sweep, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const { references } = installAdapter(() => "throw");

    const res = await call(handlerA.client, "resend", orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.platformSync).toBe("needs_action");
    expect(await readSync(orderId)).toMatchObject({
      state: "needs_action",
      next_at: null,
    });

    expect(await sweep(new Date(Date.now() + 100 * HOUR_MS))).toBe(0);
    expect(references).toHaveLength(1);
  });

  it("legend-eyqvo two resends at the same time call the platform once; the sweep skips the in-flight call", async () => {
    const { handlerA, seedOrder, readSync, sweep, call } = await setup();
    const orderId = await seedOrder("needs_action");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { references } = installAdapter(() => "accept", gate);

    // supertest requests are lazy: `.then` is what sends them.
    const first = call(handlerA.client, "resend", orderId).then((r) => r);
    // The first platform call is now in flight.
    await waitUntil(() => references.length === 1);
    const second = call(handlerA.client, "resend", orderId).then((r) => r);
    // A sweep inside the lease (5 min) must not call the platform for this
    // order. Allowed to wait on a row lock: only the outcome is asserted, after release.
    const sweeping = sweep(new Date(Date.now() + 60_000));
    await Promise.race([
      sweeping,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(await sweeping).toBe(0);

    expect(references).toEqual([`${orderId}:accepted`]);
    const statuses = [one.status, two.status].sort();
    expect(statuses, JSON.stringify([one.body, two.body])).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(errorCode(loser.body)).toBe("DELIVERY_SYNC_NOT_PENDING");
    expect(references).toEqual([`${orderId}:accepted`]);
    expect((await readSync(orderId)).state).toBe("ok");
  });
});

describe("legend-eyqvo staff resolve of a needs_action order", () => {
  it("legend-eyqvo resolve clears the sync flag, audits who, when and why, and a second resolve is 409", async () => {
    const { handlerA, seedOrder, readSync, auditEvents, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const adapter = installAdapter(() => "accept");
    const before = Date.now();

    const res = await call(handlerA.client, "resolve", orderId, {
      body: { reason: "Sudah diterima manual di aplikasi mitra" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(deliveryChannelOrderSchema.parse(res.body.data).platformSync).toBe(
      "ok",
    );
    expect(await readSync(orderId)).toMatchObject({
      state: "ok",
      action: null,
      status: null,
      attempts: 0,
      next_at: null,
    });
    // Resolve never calls the platform.
    expect(adapter.references).toEqual([]);

    const events = await auditEvents(
      orderId,
      "delivery_order.platform_resolved",
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      actorType: "user",
      actorId: handlerA.userId,
    });
    expect(JSON.stringify(event)).toContain(
      "Sudah diterima manual di aplikasi mitra",
    );
    const at = new Date(event.createdAt as string).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);

    const again = await call(handlerA.client, "resolve", orderId);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(errorCode(again.body)).toBe("DELIVERY_SYNC_NOT_PENDING");
    expect(
      await auditEvents(orderId, "delivery_order.platform_resolved"),
    ).toHaveLength(1);
  });

  it("legend-eyqvo resolve works without a reason", async () => {
    const { handlerA, seedOrder, readSync, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const res = await call(handlerA.client, "resolve", orderId, { body: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readSync(orderId)).state).toBe("ok");
  });
});

describe("legend-eyqvo orders that are not needs_action", () => {
  for (const state of ["ok", "retrying"] as const)
    it(`legend-eyqvo resend and resolve of a ${state} order are 409 DELIVERY_SYNC_NOT_PENDING`, async () => {
      const { handlerA, seedOrder, readSync, call } = await setup();
      const orderId = await seedOrder(state);
      const adapter = installAdapter(() => "accept");
      const before = await readSync(orderId);

      for (const action of ["resend", "resolve"] as const) {
        const res = await call(handlerA.client, action, orderId);
        expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(409);
        expect(errorCode(res.body)).toBe("DELIVERY_SYNC_NOT_PENDING");
      }
      expect(adapter.references).toEqual([]);
      expect(await readSync(orderId)).toEqual(before);
    });
});

describe("legend-eyqvo access and input rules", () => {
  it("legend-eyqvo a handler of outlet A is refused (403) on the outlet B path", async () => {
    const { handlerA, outletB, seedOrder, readSync, call } = await setup();
    const orderB = await seedOrder("needs_action", outletB);
    const adapter = installAdapter(() => "accept");
    for (const action of ["resend", "resolve"] as const) {
      const res = await call(handlerA.client, action, orderB, {
        outletId: outletB,
      });
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(adapter.references).toEqual([]);
    expect((await readSync(orderB)).state).toBe("needs_action");
  });

  it("legend-eyqvo a role without delivery.order.handle is refused (403)", async () => {
    const { noGate, seedOrder, readSync, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const adapter = installAdapter(() => "accept");
    for (const action of ["resend", "resolve"] as const) {
      const res = await call(noGate.client, action, orderId);
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(adapter.references).toEqual([]);
    expect((await readSync(orderId)).state).toBe("needs_action");
  });

  it("legend-eyqvo an order of outlet B through the outlet A path is 404 DELIVERY_ORDER_NOT_FOUND", async () => {
    const { handlerA, outletB, seedOrder, readSync, call } = await setup();
    const orderB = await seedOrder("needs_action", outletB);
    const adapter = installAdapter(() => "accept");
    for (const action of ["resend", "resolve"] as const) {
      const res = await call(handlerA.client, action, orderB);
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(errorCode(res.body)).toBe("DELIVERY_ORDER_NOT_FOUND");
    }
    expect(adapter.references).toEqual([]);
    expect((await readSync(orderB)).state).toBe("needs_action");
  });

  it("legend-eyqvo an unknown order id is 404 DELIVERY_ORDER_NOT_FOUND", async () => {
    const { handlerA, call } = await setup();
    const res = await call(handlerA.client, "resend", randomUUID());
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("DELIVERY_ORDER_NOT_FOUND");
  });

  it("legend-eyqvo an untrusted origin is refused and changes nothing", async () => {
    const { handlerA, seedOrder, readSync, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const adapter = installAdapter(() => "accept");
    for (const action of ["resend", "resolve"] as const) {
      const res = await call(handlerA.client, action, orderId, {
        origin: "https://evil.example",
      });
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(adapter.references).toEqual([]);
    expect((await readSync(orderId)).state).toBe("needs_action");
  });

  it("legend-eyqvo a body with an extra key is rejected (422) and changes nothing", async () => {
    const { handlerA, seedOrder, readSync, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const adapter = installAdapter(() => "accept");
    for (const action of ["resend", "resolve"] as const) {
      const res = await call(handlerA.client, action, orderId, {
        body: { unexpected: true },
      });
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(422);
    }
    expect(adapter.references).toEqual([]);
    expect((await readSync(orderId)).state).toBe("needs_action");
  });

  it("legend-eyqvo an anonymous caller is refused (401)", async () => {
    const { seedOrder, call } = await setup();
    const orderId = await seedOrder("needs_action");
    const res = await call(agent(app), "resend", orderId);
    expect(res.status).toBe(401);
  });
});
