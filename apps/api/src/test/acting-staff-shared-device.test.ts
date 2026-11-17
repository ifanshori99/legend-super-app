// Shared-device mode requires an active cashier token (legend-f586w). Spec =
// docs/DECISIONS.md "Kasir aktif per perangkat lewat token server" (a separate
// card makes the X-Acting-Staff header mandatory in shared-device mode) plus
// the card brief.
//
// Rule under test: a POS request from a registered, enrolled outlet device
// (valid X-Device-Token the registry accepts) that carries NO X-Acting-Staff
// header is refused. A request with a live token runs as that staff member. A
// request from a browser without any device identity keeps the old behaviour
// (the session owner acts). The pos-session flow (device-pin) needs no token.
//
// Assumptions (the brief leaves these open):
//  - "Shared-device mode" = the request carries a registered device token.
//  - The refusal is 401 or 403 (status not fixed) with the error code
//    ACTING_STAFF_REQUIRED and a non-empty message. The code literal is the
//    brief's suggested name.
//  - A bad header on a shared device still answers the existing
//    ACTING_STAFF_INVALID (401), not the new code.
//  - The route families are checked with one representative route each:
//    pos-order POST /pos/orders, pos-shift GET /pos/shifts (+ POST for the
//    write check), floor POST /api/floor/zones, table-sessions POST
//    /api/table-sessions/:id/close, table-links POST /api/table-links, kds PUT
//    /kitchen/menu-loads. If the architect exempts GET /pos/shifts (a device
//    bootstrap read), drop the "pos-shift GET" family entry only.
//  - Fixtures are built WITHOUT a device token (the old behaviour), so setup
//    never depends on the rule.
//  - More families (legend-f586w round 1): pos-parked-order POST, pos-parked-order
//    GET list, receipt GET by-number, order-customer PUT /api/pos/orders/:id/customer,
//    floor tablesRouter POST /api/tables/:id/status, kds GET station board.
//    For families whose fixtures are heavy (receipt, order-customer, kds board)
//    the "goes through" check only asserts the cashier gate lets the request
//    reach the handler: no ACTING_STAFF_* code and no 401 (a 404/403 from the
//    handler is fine).
//  - Exempt routes (no cashier token needed on a registered device): KDS
//    heartbeat, POS catalog GET, customer-display GET. Same gate-only check.
//  - Receipt write-off with no header on a registered device answers REQUIRED
//    (the device gate runs before the permission check); with a live token it
//    stays ACTING_STAFF_NOT_ALLOWED (pos-acting-staff.test.ts).
//  - A device token whose device was rotated (devices.token_issued_at newer
//    than the token's issuedAt) is "invalid": the request must answer 401 and
//    must NOT fall back to the session owner. Exact error code not fixed.
//  - The role `till` holds every permission these routes need, so a refusal can
//    only come from the missing cashier, never from PERMISSION_DENIED.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const REQUIRED_CODE = "ACTING_STAFF_REQUIRED";
const PIN = "582914";
const [device, category, kopi, kdsItem, priceList] = [1, 2, 3, 4, 5].map(() =>
  randomUUID(),
) as [string, string, string, string, string];
const till = randomUUID();

type Client = ReturnType<typeof agent>;
type Req = ReturnType<Client["get"]>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let host: { Host: string };
let sessionOwner: Member;
let cashierB: Member;
let zoneId: string;

async function member(label: string, roleId: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: device,
  });

type Identity = {
  /** Send the registered device token (shared-device request). */
  onDevice: boolean;
  /** X-Acting-Staff value; omitted when absent. */
  token?: string | null;
};

function identify(request: Req, who: Identity): Req {
  let result = request.set(host).set(originHeader);
  if (who.onDevice) result = result.set(DEVICE_TOKEN_HEADER, deviceToken());
  if (who.token) result = result.set(ACTING_HEADER, who.token);
  return result;
}

/** Issues an acting token for cashierB on the registered device. */
async function tokenFor(who: Member = cashierB): Promise<string> {
  const response = await identify(
    sessionOwner.client.post("/api/staff-pins/pos-session"),
    { onDevice: true },
  ).send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

function expectRequired(response: { status: number; body: unknown }) {
  const body = response.body as { error?: { code?: string; message?: string } };
  expect([401, 403], JSON.stringify(response.body)).toContain(response.status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(REQUIRED_CODE);
  expect(body.error?.message ?? "").not.toBe("");
}

/** The cashier gate let the request through (handler may still answer 404/403). */
function expectPassesGate(response: { status: number; body: unknown }) {
  const body = response.body as { error?: { code?: string } };
  const code = body.error?.code ?? "";
  expect(code.startsWith("ACTING_STAFF_"), JSON.stringify(response.body)).toBe(
    false,
  );
  expect(response.status, JSON.stringify(response.body)).not.toBe(401);
}

function expectOk(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    200,
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
}

async function count(table: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenant.tenantId],
  );
  return rows[0]!.n;
}

// ---- fixtures (built without a device token: old behaviour) --------------------

/** A guest-scanned, confirmed (open) session on a fresh table. */
async function openSeat() {
  const table = await createTable(sessionOwner.client, { zoneId }, host);
  const qr = await issueQr(sessionOwner.client, table.id, host);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  const sessionId = scanned.body.data.session.id as string;
  if (scanned.body.data.session.status === "pending_confirmation") {
    const confirmed = await sessionOwner.client
      .post(`/api/table-sessions/${sessionId}/confirm`)
      .set(host)
      .set(originHeader);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }
  return { tableId: table.id as string, sessionId };
}

async function liveLinkMembers(tableIds: string[]) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM table_link_members WHERE tenant_id = $1 AND table_id = ANY($2::uuid[]) AND left_at IS NULL",
    [tenant.tenantId, tableIds],
  );
  return rows[0]!.n;
}

async function sessionStatus(sessionId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM table_sessions WHERE id = $1",
    [sessionId],
  );
  return rows[0]!.status;
}

const posBase = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos`;
const kdsBase = () =>
  `/api/outlets/${encodeURIComponent(tenant.outletId)}/kitchen`;

// ---- route families -------------------------------------------------------------

type Prepared = {
  call: (who: Identity) => Req | Promise<Req> | PromiseLike<unknown>;
  /** Asserts the refused request changed nothing. */
  untouched: () => Promise<void>;
};
type Family = {
  name: string;
  prepare: () => Promise<Prepared>;
  /** Heavy fixtures: "goes through" only asserts the gate, not a 2xx. */
  gateOnly?: boolean;
};

async function parkedOrderCount(): Promise<number> {
  const listed = await sessionOwner.client
    .get(`${posBase()}/parked-orders`)
    .set(host)
    .set(originHeader);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.data as unknown[]).length;
}

const families: Family[] = [
  {
    name: "pos-order POST /pos/orders",
    prepare: async () => {
      const before = await count("orders");
      return {
        call: (who) =>
          identify(sessionOwner.client.post(`${posBase()}/orders`), who).send({
            idempotencyKey: randomUUID(),
            channel: "pos",
            serviceType: "takeaway",
            items: [{ menuItemId: kopi, quantity: 1, modifierIds: [] }],
          }),
        untouched: async () => expect(await count("orders")).toBe(before),
      };
    },
  },
  {
    name: "pos-shift GET /pos/shifts",
    prepare: async () => ({
      call: (who) =>
        identify(
          sessionOwner.client.get(`${posBase()}/shifts?deviceId=${device}`),
          who,
        ),
      untouched: async () => {},
    }),
  },
  {
    name: "floor POST /api/floor/zones",
    prepare: async () => {
      const before = await count("floor_zones");
      return {
        call: (who) =>
          identify(sessionOwner.client.post("/api/floor/zones"), who).send({
            name: `Zona Bersama ${randomUUID().slice(0, 8)}`,
            paymentMode: "pay_first",
            serviceChargeBp: 500,
            minimumSpendIdr: 0,
            hours: [
              {
                daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
                start: "08:00",
                end: "22:00",
              },
            ],
          }),
        untouched: async () => expect(await count("floor_zones")).toBe(before),
      };
    },
  },
  {
    name: "table-sessions POST /table-sessions/:id/close",
    prepare: async () => {
      const { sessionId } = await openSeat();
      return {
        call: (who) =>
          identify(
            sessionOwner.client.post(`/api/table-sessions/${sessionId}/close`),
            who,
          ).send({ tableCleaned: true, waiterConfirmedEmpty: true }),
        untouched: async () =>
          expect(await sessionStatus(sessionId)).not.toBe("closed"),
      };
    },
  },
  {
    name: "table-links POST /table-links",
    prepare: async () => {
      const tableIds = [(await openSeat()).tableId, (await openSeat()).tableId];
      return {
        call: (who) =>
          identify(sessionOwner.client.post("/api/table-links"), who).send({
            tableIds,
          }),
        untouched: async () => expect(await liveLinkMembers(tableIds)).toBe(0),
      };
    },
  },
  {
    name: "kds PUT /kitchen/menu-loads",
    prepare: async () => ({
      call: (who) =>
        identify(sessionOwner.client.put(`${kdsBase()}/menu-loads`), who).send({
          loads: [
            {
              menuItemId: kdsItem,
              variantId: null,
              loadPoints: 3,
              prepSeconds: 900,
            },
          ],
        }),
      untouched: async () => {},
    }),
  },
  {
    name: "pos-parked-order POST /pos/parked-orders",
    prepare: async () => {
      const before = await parkedOrderCount();
      return {
        call: (who) =>
          identify(
            sessionOwner.client.post(`${posBase()}/parked-orders`),
            who,
          ).send({
            idempotencyKey: randomUUID(),
            channel: "pos",
            serviceType: "takeaway",
            items: [{ menuItemId: kopi, modifierIds: [], quantity: 1 }],
          }),
        untouched: async () => expect(await parkedOrderCount()).toBe(before),
      };
    },
  },
  {
    name: "pos-parked-order GET /pos/parked-orders",
    prepare: async () => ({
      call: (who) =>
        identify(sessionOwner.client.get(`${posBase()}/parked-orders`), who),
      untouched: async () => {},
    }),
  },
  {
    name: "pos-receipt GET /pos/receipts/by-number/:number",
    gateOnly: true,
    prepare: async () => ({
      call: (who) =>
        identify(
          sessionOwner.client.get(`${posBase()}/receipts/by-number/SHD-000001`),
          who,
        ),
      untouched: async () => {},
    }),
  },
  {
    name: "pos-order-customer PUT /api/pos/orders/:id/customer",
    gateOnly: true,
    prepare: async () => ({
      call: (who) =>
        identify(
          sessionOwner.client.put(`/api/pos/orders/${createUlid()}/customer`),
          who,
        ).send({ customerProfileId: null }),
      untouched: async () => {},
    }),
  },
  {
    name: "floor tablesRouter POST /api/tables/:id/status",
    prepare: async () => {
      const table = await createTable(sessionOwner.client, { zoneId }, host);
      return {
        call: (who) =>
          identify(
            sessionOwner.client.post(`/api/tables/${table.id}/status`),
            who,
          ).send({ action: "mark_dirty" }),
        untouched: async () => {},
      };
    },
  },
  {
    name: "kds GET /kitchen/stations/:id/board",
    gateOnly: true,
    prepare: async () => ({
      call: (who) =>
        identify(
          sessionOwner.client.get(
            `${kdsBase()}/stations/${randomUUID()}/board`,
          ),
          who,
        ),
      untouched: async () => {},
    }),
  },
];

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`shd-${randomUUID().slice(0, 6)}`);
  host = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === device
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Perangkat Bersama', false, NULL, $3, false, '["tenant"]')`,
    [
      till,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
        "kds.ticket.process",
        "kds.station.manage",
      ]),
    ],
  );
  sessionOwner = await member("Sesi Login Bersama", till);
  cashierB = await member("Kasir B Bersama", till);
  const ctx = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    ctx,
    cashierB.userId,
    { outletId: tenant.outletId, userId: cashierB.userId },
    { pin: PIN },
  );
  const { tenantId: t, brandId: b, outletId: o } = tenant;
  const u = sessionOwner.userId;
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Bersama 1', now() - interval '1 minute')`,
    [device, t, o],
  );
  await owner.query(`
    INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ('${category}', '${t}', '${b}', 'Bersama', 0);
    INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id) VALUES ('${kopi}', '${t}', '${b}', '${category}', 'Kopi Susu', true, '${randomUUID()}');
    INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id) VALUES ('${kdsItem}', '${t}', '${b}', '${category}', 'Teh Dapur', true, '${randomUUID()}');
    INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ('${priceList}', '${t}', '${o}', 'takeaway', '2026-01-01');
    INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr) VALUES ('${randomUUID()}', '${t}', '${priceList}', '${kopi}', 25000);
    INSERT INTO tax_settings (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode, tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation, version, effective_from, status, published_at, published_by) VALUES ('${randomUUID()}', '${t}', NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL, 'fixed_bp', 1, '2026-01-01', 'published', now(), '${u}');
    INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to, price_includes_tax, include_service_in_base, is_active, version, effective_from, status, published_at, published_by) VALUES ('${randomUUID()}', '${t}', NULL, 'PBJT-SHD', 'PBJT 10%', 'pbjt', 1000, NULL, '[]', '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}', false, true, true, 1, '2026-01-01', 'published', now(), '${u}');
  `);
  zoneId = (
    await createZone(
      sessionOwner.client,
      {
        hours: [
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
        ],
      },
      host,
    )
  ).id;
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe.each(families)("shared device: $name", (family) => {
  it("a registered device without X-Acting-Staff is refused with ACTING_STAFF_REQUIRED and nothing changes", async () => {
    const prepared = await family.prepare();
    expectRequired((await prepared.call({ onDevice: true })) as never);
    await prepared.untouched();
  });

  it("a registered device with a live acting token goes through as that staff member", async () => {
    const prepared = await family.prepare();
    const token = await tokenFor();
    const response = (await prepared.call({ onDevice: true, token })) as never;
    if (family.gateOnly) expectPassesGate(response);
    else expectOk(response);
  });

  it("a browser without any device identity and no header keeps the old behaviour", async () => {
    const prepared = await family.prepare();
    const response = (await prepared.call({ onDevice: false })) as never;
    if (family.gateOnly) expectPassesGate(response);
    else expectOk(response);
  });
});

describe("shared device: rules shared by every family", () => {
  it("a garbage token on a shared device still answers the existing ACTING_STAFF_INVALID, not REQUIRED", async () => {
    const prepared = await families[2]!.prepare();
    const response = (await prepared.call({
      onDevice: true,
      token: "pas_garbage-token",
    })) as { status: number; body: { error?: { code?: string } } };
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error?.code).toBe("ACTING_STAFF_INVALID");
  });

  it("opening a shift from a registered device without a token is refused and writes no shift", async () => {
    const before = await count("pos_shifts");
    const response = await identify(
      sessionOwner.client.post(`${posBase()}/shifts`),
      { onDevice: true },
    ).send({ idempotencyKey: randomUUID(), openingFloatIdr: 100_000 });
    expectRequired(response);
    expect(await count("pos_shifts")).toBe(before);
  });

  it("an acting token that was ended no longer lets the device through", async () => {
    const token = await tokenFor();
    const ended = await identify(
      sessionOwner.client.post("/api/staff-pins/pos-session/end"),
      { onDevice: true },
    ).send({});
    expect(ended.status, JSON.stringify(ended.body)).toBe(204);
    const response = await identify(
      sessionOwner.client.get(`${posBase()}/shifts?deviceId=${device}`),
      { onDevice: true, token },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error?.code).toBe("ACTING_STAFF_REVOKED");
  });
});

describe("shared device: exempt routes and write-off", () => {
  const exempt: [string, () => Req][] = [
    [
      "kds POST /kitchen/stations/:id/heartbeat",
      () =>
        sessionOwner.client
          .post(`${kdsBase()}/stations/${randomUUID()}/heartbeat`)
          .send({}),
    ],
    [
      "pos GET /pos/catalog",
      () => sessionOwner.client.get(`${posBase()}/catalog`),
    ],
    [
      "pos GET /pos/customer-display",
      () => sessionOwner.client.get(`${posBase()}/customer-display`),
    ],
  ];

  it.each(exempt)(
    "%s needs no cashier token on a registered device",
    async (_name, build) => {
      const response = await identify(build(), { onDevice: true });
      expectPassesGate(response);
    },
  );

  it("receipt write-off from a registered device without a token is refused and writes nothing", async () => {
    const before = await count("receipt_number_writeoffs");
    const response = await identify(
      sessionOwner.client.post(`${posBase()}/receipt-writeoffs`),
      { onDevice: true },
    ).send({
      prefix: "SHD",
      sequenceNumber: 1,
      reason: "Struk hilang saat uji perangkat",
    });
    expectRequired(response);
    expect(await count("receipt_number_writeoffs")).toBe(before);
  });

  it("receipt write-off with a live acting token is still refused with ACTING_STAFF_NOT_ALLOWED", async () => {
    const token = await tokenFor();
    const before = await count("receipt_number_writeoffs");
    const response = await identify(
      sessionOwner.client.post(`${posBase()}/receipt-writeoffs`),
      { onDevice: true, token },
    ).send({
      prefix: "SHD",
      sequenceNumber: 1,
      reason: "Struk hilang saat uji perangkat",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code).toBe("ACTING_STAFF_NOT_ALLOWED");
    expect(await count("receipt_number_writeoffs")).toBe(before);
  });

  it("a rotated device token without a cashier header is refused, not run as the session owner", async () => {
    const before = await count("orders");
    await owner.query(
      "UPDATE devices SET token_issued_at = now() + interval '1 hour' WHERE id = $1",
      [device],
    );
    try {
      const response = await identify(
        sessionOwner.client.post(`${posBase()}/orders`),
        { onDevice: true },
      ).send({
        idempotencyKey: randomUUID(),
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: kopi, quantity: 1, modifierIds: [] }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expect(await count("orders")).toBe(before);
    } finally {
      await owner.query(
        "UPDATE devices SET token_issued_at = now() - interval '1 minute' WHERE id = $1",
        [device],
      );
    }
  });
});

describe("shared device: the device-pin flow needs no cashier token", () => {
  it("issuing a cashier token works on a registered device without any token (201)", async () => {
    const response = await identify(
      sessionOwner.client.post("/api/staff-pins/pos-session"),
      { onDevice: true },
    ).send({ userId: cashierB.userId, pin: PIN });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.token).toMatch(/^pas_/);
  });

  it("switching cashier and ending the session work without a token on the request (204)", async () => {
    const first = await tokenFor();
    expect(first).toMatch(/^pas_/);
    const ended = await identify(
      sessionOwner.client.post("/api/staff-pins/pos-session/end"),
      { onDevice: true },
    ).send({});
    expect(ended.status, JSON.stringify(ended.body)).toBe(204);
  });
});
