// KDS realtime WebSocket (bead legend-4d5; PRD v1.7 §3 F12). Acceptance:
// KDS-01 (a fired item reaches its station screen within 2 s, pushed, no
// polling) and KDS-02 (a screen that disconnects and reconnects with
// `?after=<last sequence>` gets exactly the changes it missed: nothing lost,
// nothing doubled), plus the connection gates (trusted origin, session,
// `kds.ticket.process` on the station, tenant isolation).
//
// The HTTP and database half is in kds.test.ts. Here a real HTTP server is
// created around the real Express app, `attachKdsRealtime` is attached to it
// and `listenKdsWakeups` is wired to the disposable PostgreSQL server, so the
// frames come from real committed NOTIFY wake-ups. The session resolver is
// this test's own port of `resolveConnection`: it maps a test header to a
// real staff account, because the production resolver is wired in server.ts.
//
// Assumptions where the brief is silent:
//  - `listenKdsWakeups(pool, dispatch)` resolves to a stop function (as
//    `listenNotificationWakeups`) and `dispatch` takes the parsed signal.
//  - A refused upgrade is an HTTP 403 (trusted origin, permission, unknown
//    station); a missing session is 401 or 403.
//  - Dropping the credential makes the server close the socket with 1008 at
//    the next change for that station.
//  - A cursor that cannot resume gets `hello`, `resync` and a close with
//    KITCHEN_REALTIME_RESYNC_CLOSE_CODE (4409).

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { Pool, type PoolClient } from "pg";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  KITCHEN_REALTIME_PROTOCOL,
  KITCHEN_REALTIME_RESYNC_CLOSE_CODE,
  kitchenRealtimeMessageSchema,
  type KitchenRealtimeMessage,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import {
  attachKdsRealtime,
  listenKdsWakeups,
} from "../services/kds-realtime.ts";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ids = {
  category: randomUUID(),
  priceList: randomUUID(),
  kopi: randomUUID(),
  nasi: randomUUID(),
  barA: randomUUID(),
  kitchenA: randomUUID(),
  screenLimitStation: randomUUID(),
  cashierRole: randomUUID(),
  kdsRole: randomUUID(),
  kdsRoleB: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };
type Principal = { userId: string; tenantId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let cashier: Member;
let cook: Member;
let noKds: Member;
let tenantBCook: Member;

let server: Server;
let realtime: ReturnType<typeof attachKdsRealtime>;
let stopListening: () => Promise<void>;
let listenerPool: Pool;
let port = 0;

/** Test header value -> account. Removing an entry drops the credential. */
const principals = new Map<string, Principal>();

const scopedContext = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [id, tenantId, name, JSON.stringify(permissions)],
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`kdsw-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`kdsx-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };

  await insertRole(tenant.tenantId, ids.cashierRole, "WS Kasir Uji", [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "pos.discount.apply",
    "pos.void.request",
  ]);
  await insertRole(tenant.tenantId, ids.kdsRole, "WS Dapur Uji", [
    "kds.ticket.process",
  ]);
  await insertRole(tenantB.tenantId, ids.kdsRoleB, "WS Dapur Tenant B", [
    "kds.ticket.process",
  ]);
  cashier = await member(tenant, ids.cashierRole, "WS Kasir");
  noKds = await member(tenant, ids.cashierRole, "WS Tanpa Akses");
  cook = await member(tenant, ids.kdsRole, "WS Koki");
  tenantBCook = await member(tenantB, ids.kdsRoleB, "WS Tenant B");

  await asOwnerTenant(tenant.tenantId, async (client) => {
    for (const [id, name, type] of [
      [ids.barA, "Bar WS", "beverage_bar"],
      [ids.kitchenA, "Dapur WS", "hot_kitchen"],
      [ids.screenLimitStation, "Layar WS", "cold_kitchen"],
    ])
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, tenant.outletId, name, type],
      );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'WS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name, stationId] of [
      [ids.kopi, "Kopi Susu", ids.barA],
      [ids.nasi, "Nasi Goreng", ids.kitchenA],
    ])
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
          stationId,
        ],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const id of [ids.kopi, ids.nasi])
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 20000)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id],
      );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cook.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-WS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cook.userId],
    );
  });

  principals.set("cook", { userId: cook.userId, tenantId: tenant.tenantId });
  principals.set("cook-revocable", {
    userId: cook.userId,
    tenantId: tenant.tenantId,
  });
  principals.set("no-kds", { userId: noKds.userId, tenantId: tenant.tenantId });
  principals.set("tenant-b", {
    userId: tenantBCook.userId,
    tenantId: tenantB.tenantId,
  });

  server = createServer();
  realtime = attachKdsRealtime(server, {
    trustedOrigins: [WEB_ORIGIN],
    resolveConnection: async (request) => {
      const key = request.headers["x-test-user"];
      const principal =
        typeof key === "string" ? principals.get(key) : undefined;
      return principal
        ? {
            userId: principal.userId,
            context: scopedContext(principal.tenantId),
          }
        : null;
    },
  });
  listenerPool = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 2,
  });
  stopListening = await listenKdsWakeups(listenerPool, realtime.dispatch);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  port = address.port;
});

afterAll(async () => {
  await stopListening?.();
  await realtime?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await listenerPool?.end();
  // KDS history is append-only: the tenants stay in the disposable database.
  for (const t of [tenant, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- POS / KDS helpers ----------------------------------------------------------------

/** Prepare a POS order, optionally keeping every line held for explicit fire. */
async function prepareOrder(menuItemIds: string[], holdItems = false) {
  const base = `/api/outlets/${tenant.outletId}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  const created = await send("", {
    channel: "pos",
    serviceType: "takeaway",
    holdItems,
    items: menuItemIds.map((menuItemId) => ({
      menuItemId,
      quantity: 1,
      modifierIds: [],
    })),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await send(`/${orderId}/submit`, {
      expectedStatus: status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const read = await cashier.client
    .get(`${base}/${orderId}`)
    .set(headers)
    .set(originHeader);
  const held = (
    read.body.data.items as { id: string; fireStatus: string }[]
  ).filter((item) => item.fireStatus === "held");
  return {
    orderId,
    async fire() {
      if (held.length === 0) return;
      const fired = await send(`/${orderId}/fire`, {
        itemIds: held.map((item) => item.id),
        expectedStatus: read.body.data.status,
      });
      expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    },
  };
}

/** Create (+ submit) a POS order and fire whatever is still held. */
async function placeOrder(menuItemIds: string[]): Promise<string> {
  const order = await prepareOrder(menuItemIds);
  await order.fire();
  return order.orderId;
}

async function ticketOn(orderId: string, stationId: string): Promise<string> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
    client.query<{ id: string }>(
      `SELECT id::text AS id FROM kitchen_tickets
       WHERE order_id = $1::uuid AND station_id = $2::uuid`,
      [ulidToUuid(orderId), stationId],
    ),
  );
  if (!rows[0]) throw new Error(`No ticket of ${orderId} on ${stationId}`);
  return uuidToUlid(rows[0].id);
}

async function startTicket(ticketId: string) {
  const response = await cook.client
    .post(`/api/outlets/${tenant.outletId}/kitchen/tickets/${ticketId}/start`)
    .set(headers)
    .set(originHeader)
    .send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function cursorOf(stationId: string): Promise<number> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
    client.query<{ last_sequence: number }>(
      `SELECT last_sequence::int AS last_sequence FROM kitchen_station_cursors
       WHERE station_id = $1::uuid`,
      [stationId],
    ),
  );
  return rows[0]?.last_sequence ?? 0;
}

// ---- WebSocket helpers ------------------------------------------------------------------

function urlOf(
  stationId: string,
  after?: number | string,
  outletId: string = tenant.outletId,
): string {
  const query = after === undefined ? "" : `?after=${after}`;
  return `ws://127.0.0.1:${port}/api/outlets/${outletId}/kitchen/stations/${stationId}/realtime${query}`;
}

type Client = {
  ws: WebSocket;
  frames: unknown[];
  /** Resolves once the predicate holds over the parsed frames, or rejects. */
  until(
    predicate: (frames: KitchenRealtimeMessage[]) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  parsed(): KitchenRealtimeMessage[];
  tickets(): Extract<KitchenRealtimeMessage, { type: "ticket" }>[];
};

const open: WebSocket[] = [];

/** Connect and start recording frames before the first one can arrive. */
function connect(
  stationId: string,
  options: {
    after?: number | string;
    user?: string | null;
    origin?: string;
    outletId?: string;
  } = {},
): Client {
  const user = options.user === undefined ? "cook" : options.user;
  const ws = new WebSocket(
    urlOf(stationId, options.after, options.outletId),
    KITCHEN_REALTIME_PROTOCOL,
    {
      headers: {
        origin: options.origin ?? WEB_ORIGIN,
        ...(user ? { "x-test-user": user } : {}),
      },
    },
  );
  open.push(ws);
  // Errors on refused upgrades are asserted through events, not thrown.
  ws.on("error", () => {});
  const frames: unknown[] = [];
  const waiters = new Set<() => void>();
  ws.on("message", (data) => {
    frames.push(JSON.parse(String(data)));
    for (const wake of waiters) wake();
  });
  ws.on("close", () => {
    for (const wake of waiters) wake();
  });
  const parsed = () =>
    frames.map((frame) => kitchenRealtimeMessageSchema.parse(frame));
  return {
    ws,
    frames,
    parsed,
    tickets: () =>
      parsed().filter(
        (frame): frame is Extract<KitchenRealtimeMessage, { type: "ticket" }> =>
          frame.type === "ticket",
      ),
    until(predicate, timeoutMs = 5_000) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `Timed out waiting for frames; got ${JSON.stringify(frames)}`,
            ),
          );
        }, timeoutMs);
        const check = () => {
          if (predicate(parsed())) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve();
          }
        };
        waiters.add(check);
        check();
      });
    },
  };
}

/** Wait for the socket to open, failing fast when the upgrade is refused. */
async function opened(client: Client): Promise<void> {
  await Promise.race([
    once(client.ws, "open"),
    once(client.ws, "unexpected-response").then(([, response]) => {
      throw new Error(`Upgrade refused with ${response.statusCode}`);
    }),
  ]);
}

/** The HTTP status of a refused upgrade. */
async function refusal(client: Client): Promise<number> {
  const [, response] = await once(client.ws, "unexpected-response");
  const status = (response as { statusCode?: number }).statusCode ?? 0;
  client.ws.terminate();
  return status;
}

/** Give late, unexpected frames a moment to show up (negative assertions). */
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  // A close call only starts the handshake. Finish it before the next test
  // so previous screens cannot retain slots in the station's connection cap.
  await Promise.all(
    open.splice(0).map(async (ws) => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) =>
        ws.once("close", () => resolve()),
      );
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
      await closed;
    }),
  );
});

const ticketIdsOf = (client: Client) =>
  client.tickets().map((frame) => frame.entry.ticket.id);

// ===== KDS-01 =====================================================================

describe("KDS-01 realtime delivery", () => {
  it("KDS-01 the socket answers with the KDS subprotocol and greets with the station's current cursor", async () => {
    const cursor = await cursorOf(ids.barA);
    const client = connect(ids.barA);
    await opened(client);
    expect(client.ws.protocol).toBe(KITCHEN_REALTIME_PROTOCOL);
    await client.until((frames) => frames.length >= 1);
    expect(client.parsed()[0]).toEqual({
      type: "hello",
      stationId: ids.barA,
      sequence: cursor,
    });
    // Without `after` nothing is replayed.
    await settle();
    expect(client.tickets()).toEqual([]);
    client.ws.close();
  });

  it("KDS-01 a fired item is pushed to its station within 2 s, and only to that station", async () => {
    const cursor = await cursorOf(ids.barA);
    const bar = connect(ids.barA, { after: cursor });
    const kitchen = connect(ids.kitchenA, {
      after: await cursorOf(ids.kitchenA),
    });
    await Promise.all([opened(bar), opened(kitchen)]);
    await Promise.all([
      bar.until((frames) => frames.length >= 1),
      kitchen.until((frames) => frames.length >= 1),
    ]);

    const order = await prepareOrder([ids.kopi], true);
    expect(bar.tickets()).toEqual([]);
    const started = performance.now();
    await order.fire();
    await bar.until((frames) =>
      frames.some((frame) => frame.type === "ticket"),
    );
    const elapsed = performance.now() - started;
    // PRD KDS-01: "Item tampil di KDS stasiun benar ≤ 2 detik setelah fire".
    expect(elapsed).toBeLessThan(2_000);

    const orderId = order.orderId;
    const ticketId = await ticketOn(orderId, ids.barA);
    const [frame] = bar.tickets();
    expect(bar.tickets()).toHaveLength(1);
    expect(frame).toMatchObject({
      type: "ticket",
      stationId: ids.barA,
      entry: {
        sequence: cursor + 1,
        ticket: {
          id: ticketId,
          orderId,
          stationId: ids.barA,
          status: "new",
        },
      },
    });
    expect(frame?.entry.ticket.items.map((item) => item.name)).toEqual([
      "Kopi Susu",
    ]);

    // The kitchen screen got nothing for a bar-only order.
    await settle();
    expect(kitchen.tickets()).toEqual([]);
    bar.ws.close();
    kitchen.ws.close();
  });

  it("KDS-03 a later change to a ticket is pushed as that ticket's new state", async () => {
    const cursor = await cursorOf(ids.kitchenA);
    const client = connect(ids.kitchenA, { after: cursor });
    await opened(client);
    const orderId = await placeOrder([ids.nasi]);
    const ticketId = await ticketOn(orderId, ids.kitchenA);
    await client.until((frames) =>
      frames.some(
        (frame) =>
          frame.type === "ticket" && frame.entry.ticket.id === ticketId,
      ),
    );
    await startTicket(ticketId);
    await client.until((frames) =>
      frames.some(
        (frame) =>
          frame.type === "ticket" &&
          frame.entry.ticket.id === ticketId &&
          frame.entry.ticket.status === "in_progress",
      ),
    );
    const sequences = client.tickets().map((frame) => frame.entry.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
    client.ws.close();
  });
});

// ===== KDS-02 =====================================================================

describe("KDS-02 reconnect without loss or duplicates", () => {
  it("KDS-02 reconnecting with after=<last sequence> replays exactly the changes made while offline, then continues live", async () => {
    const start = await cursorOf(ids.barA);
    const first = connect(ids.barA, { after: start });
    await opened(first);
    const order1 = await placeOrder([ids.kopi]);
    const ticket1 = await ticketOn(order1, ids.barA);
    await first.until((frames) =>
      frames.some((f) => f.type === "ticket" && f.entry.ticket.id === ticket1),
    );
    const lastSeen = first.tickets().at(-1)!.entry.sequence;
    first.ws.close();
    await once(first.ws, "close");

    // Two changes while the screen is offline: a new ticket and a change to
    // the one it already showed.
    const order2 = await placeOrder([ids.kopi]);
    const ticket2 = await ticketOn(order2, ids.barA);
    await startTicket(ticket1);

    const second = connect(ids.barA, { after: lastSeen });
    await opened(second);
    await second.until((frames) => frames.length >= 3);
    await settle();
    expect(second.parsed()[0]).toEqual({
      type: "hello",
      stationId: ids.barA,
      sequence: await cursorOf(ids.barA),
    });
    // Exactly the two missed changes, ascending, each ticket once.
    expect(second.tickets()).toHaveLength(2);
    expect(ticketIdsOf(second)).toEqual([ticket2, ticket1]);
    const replayed = second.tickets().map((frame) => frame.entry);
    expect(replayed.every((entry) => entry.sequence > lastSeen)).toBe(true);
    expect(replayed[0]!.sequence).toBeLessThan(replayed[1]!.sequence);
    expect(replayed[1]!.ticket.status).toBe("in_progress");

    // And live again afterwards: one more ticket, never a repeat of the others.
    const order3 = await placeOrder([ids.kopi]);
    const ticket3 = await ticketOn(order3, ids.barA);
    await second.until((frames) =>
      frames.some((f) => f.type === "ticket" && f.entry.ticket.id === ticket3),
    );
    await settle();
    expect(ticketIdsOf(second)).toEqual([ticket2, ticket1, ticket3]);
    second.ws.close();
  });

  it("KDS-02 several offline changes to one ticket replay as a single entry with its latest state", async () => {
    const order = await placeOrder([ids.nasi]);
    const ticket = await ticketOn(order, ids.kitchenA);
    const cursor = await cursorOf(ids.kitchenA);

    await startTicket(ticket);
    const bumped = await cook.client
      .post(`/api/outlets/${tenant.outletId}/kitchen/tickets/${ticket}/bump`)
      .set(headers)
      .set(originHeader)
      .send({});
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);

    const client = connect(ids.kitchenA, { after: cursor });
    await opened(client);
    await client.until((frames) => frames.length >= 2);
    await settle();
    expect(ticketIdsOf(client)).toEqual([ticket]);
    expect(client.tickets()[0]?.entry.ticket.status).toBe("done");
    expect(client.tickets()[0]?.entry.sequence).toBe(
      await cursorOf(ids.kitchenA),
    );
    client.ws.close();
  });

  it("KDS-02 a screen whose cursor is already current gets only the hello frame", async () => {
    const cursor = await cursorOf(ids.barA);
    const client = connect(ids.barA, { after: cursor });
    await opened(client);
    await client.until((frames) => frames.length >= 1);
    await settle();
    expect(client.parsed()).toEqual([
      { type: "hello", stationId: ids.barA, sequence: cursor },
    ]);
    client.ws.close();
  });

  it("KDS-02 two screens on the same station each receive every change exactly once", async () => {
    const cursor = await cursorOf(ids.barA);
    const left = connect(ids.barA, { after: cursor });
    const right = connect(ids.barA, { after: cursor });
    await Promise.all([opened(left), opened(right)]);
    const order = await placeOrder([ids.kopi]);
    const ticketId = await ticketOn(order, ids.barA);
    await startTicket(ticketId);
    for (const client of [left, right])
      await client.until((frames) =>
        frames.some(
          (f) =>
            f.type === "ticket" &&
            f.entry.ticket.id === ticketId &&
            f.entry.ticket.status === "in_progress",
        ),
      );
    await settle();
    for (const client of [left, right]) {
      const sequences = client.tickets().map((frame) => frame.entry.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(ticketIdsOf(client).every((id) => id === ticketId)).toBe(true);
    }
    left.ws.close();
    right.ws.close();
  });
});

describe("KDS-02 an untrusted cursor gets a resync frame, then a close", () => {
  // Stations of a type no menu item maps to, so seeded cursors never mix with
  // the stations the other tests count on.
  async function seededStation(
    type: "coffee_bar" | "cold_kitchen" | "pastry",
    cursor: number,
    sequences: number[],
  ): Promise<string> {
    const stationId = randomUUID();
    const orderId = await placeOrder([ids.kopi]);
    const ticketId = ulidToUuid(await ticketOn(orderId, ids.barA));
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [
          stationId,
          tenant.tenantId,
          tenant.outletId,
          `Uji resync ${stationId.slice(0, 8)}`,
          type,
        ],
      );
      await client.query(
        `INSERT INTO kitchen_station_cursors (tenant_id, outlet_id, station_id, last_sequence)
         VALUES ($1, $2, $3, $4)`,
        [tenant.tenantId, tenant.outletId, stationId, cursor],
      );
      for (const sequence of sequences)
        await client.query(
          `INSERT INTO kitchen_station_feed (id, tenant_id, outlet_id, station_id, sequence, ticket_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6::uuid, now())`,
          [
            randomUUID(),
            tenant.tenantId,
            tenant.outletId,
            stationId,
            sequence,
            ticketId,
          ],
        );
    });
    return stationId;
  }

  /** hello, then resync with the station cursor, then a 4409 close. */
  async function expectResync(
    stationId: string,
    after: number,
    cursor: number,
  ) {
    const client = connect(stationId, { after });
    const closed = once(client.ws, "close");
    await opened(client);
    const [code] = await closed;
    expect(code).toBe(KITCHEN_REALTIME_RESYNC_CLOSE_CODE);
    expect(client.parsed()).toEqual([
      { type: "hello", stationId, sequence: cursor },
      { type: "resync", stationId, sequence: cursor },
    ]);
  }

  it("KDS-02 an after ahead of the station gets hello, resync and a 4409 close", async () => {
    const cursor = await cursorOf(ids.barA);
    await expectResync(ids.barA, cursor + 10, cursor);
  });

  it("KDS-02 an after more than the lag limit behind gets resync; one at the limit still replays", async () => {
    const station = await seededStation("coffee_bar", 5_000, [3_001, 5_000]);
    await expectResync(station, 100, 5_000);
    const client = connect(station, { after: 3_000 });
    await opened(client);
    await client.until((frames) => frames.length >= 2);
    expect(client.parsed().map((frame) => frame.type)).toEqual([
      "hello",
      "ticket",
    ]);
    client.ws.close();
  });

  it("KDS-02 an after whose following rows were pruned gets resync", async () => {
    const station = await seededStation("cold_kitchen", 10, [6, 7, 8, 9, 10]);
    await expectResync(station, 2, 10);
  });

  it("KDS-02 a screen that falls too far behind while connected gets resync and a 4409 close", async () => {
    const station = await seededStation("pastry", 10, [8, 9, 10]);
    const client = connect(station, { after: 10 });
    const closed = once(client.ws, "close");
    await opened(client);
    await client.until((frames) => frames.length >= 1);
    // The station moves 4990 changes ahead (owner write) and the wake-up for
    // it reaches the relay: the catch-up hits the lag limit.
    await asOwnerTenant(tenant.tenantId, (clientDb) =>
      clientDb.query(
        "UPDATE kitchen_station_cursors SET last_sequence = 5000 WHERE station_id = $1",
        [station],
      ),
    );
    await realtime.dispatch({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      stationId: station,
      sequence: 5_000,
    });
    const [code] = await closed;
    expect(code).toBe(KITCHEN_REALTIME_RESYNC_CLOSE_CODE);
    expect(client.parsed().at(-1)).toEqual({
      type: "resync",
      stationId: station,
      sequence: 5_000,
    });
  });

  it("KDS-02 a burst of wake-ups delivers each change exactly once", async () => {
    const cursor = await cursorOf(ids.barA);
    const client = connect(ids.barA, { after: cursor });
    await opened(client);
    await client.until((frames) => frames.length >= 1);

    const burst = 5;
    await Promise.all(
      Array.from({ length: burst }, () => placeOrder([ids.kopi])),
    );
    const last = await cursorOf(ids.barA);
    // Repeated and stale signals on top of the real NOTIFY wake-ups.
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        realtime.dispatch({
          tenantId: tenant.tenantId,
          outletId: tenant.outletId,
          stationId: ids.barA,
          sequence: index % 2 === 0 ? last : cursor + 1,
        }),
      ),
    );
    await client.until(
      (frames) => frames.filter((f) => f.type === "ticket").length >= burst,
    );
    await settle();
    const sequences = client.tickets().map((frame) => frame.entry.sequence);
    expect(sequences).toHaveLength(burst);
    expect(new Set(sequences).size).toBe(burst);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(sequences.at(-1)).toBe(last);
    expect(new Set(ticketIdsOf(client)).size).toBe(burst);
    client.ws.close();
  });
});

// ===== Connection gates ==============================================================

describe("KDS realtime access control", () => {
  it("TEN-01 another tenant's account is refused when it names this tenant's station", async () => {
    const client = connect(ids.kitchenA, { user: "tenant-b", after: 0 });
    expect(await refusal(client)).toBe(403);
    expect(client.frames).toEqual([]);
  });

  it("TEN-03 an account without kds.ticket.process on the station is refused", async () => {
    const client = connect(ids.kitchenA, { user: "no-kds", after: 0 });
    expect(await refusal(client)).toBe(403);
  });

  it("TEN-03 an unknown station is refused (fail closed)", async () => {
    const client = connect(randomUUID());
    expect(await refusal(client)).toBe(403);
  });

  it("TEN-03 a connection without a session is refused", async () => {
    const client = connect(ids.kitchenA, { user: null });
    expect([401, 403]).toContain(await refusal(client));
  });

  it("TEN-03 an untrusted origin is refused even for a valid account", async () => {
    const client = connect(ids.kitchenA, {
      origin: "https://untrusted.invalid",
    });
    expect(await refusal(client)).toBe(403);
  });

  it("TEN-03 a client that sends a data frame is disconnected with 1008", async () => {
    const client = connect(ids.barA);
    await opened(client);
    const closed = once(client.ws, "close");
    client.ws.send(JSON.stringify({ type: "ping" }));
    const [code] = await closed;
    expect(code).toBe(1008);
  });

  it("TEN-03 a screen whose credential was withdrawn is disconnected with 1008 at the next change", async () => {
    const client = connect(ids.barA, {
      user: "cook-revocable",
      after: await cursorOf(ids.barA),
    });
    await opened(client);
    await client.until((frames) => frames.length >= 1);
    principals.delete("cook-revocable");
    const closed = once(client.ws, "close");
    await placeOrder([ids.kopi]);
    const [code] = await closed;
    expect(code).toBe(1008);
    // No change reached the withdrawn screen.
    expect(client.tickets()).toEqual([]);
  });

  it("TEN-03 a station accepts at most 20 screens at once", async () => {
    // Use a fresh station: this assertion counts only its own screens.
    const clients = Array.from({ length: 20 }, () =>
      connect(ids.screenLimitStation),
    );
    await Promise.all(clients.map(opened));
    await Promise.all(
      clients.map((client) => client.until((frames) => frames.length === 1)),
    );
    const extra = connect(ids.screenLimitStation);
    // Refused over HTTP, or accepted and closed straight away: never served.
    const outcome = await Promise.race([
      once(extra.ws, "unexpected-response").then(() => "refused"),
      once(extra.ws, "close").then(() => "closed"),
    ]);
    expect(["refused", "closed"]).toContain(outcome);
    extra.ws.terminate();
    for (const client of clients) client.ws.close();
  });
});
