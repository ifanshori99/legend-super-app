// Table-session deposit lock (bead legend-94qt). A reservation DP is credited
// to a table session; every live order of that session may apply only what the
// others have not applied yet. Before the fix, two concurrent POS reprices (or
// a POS create racing a QR pay-first checkout) both read "nothing applied yet"
// and both took the same credit, so the session applied more deposit than it
// ever received. `lockSessionDeposit` (qr-order-ports.ts) serializes the
// read-then-write; these tests prove the invariant through the real HTTP
// routes with real concurrent transactions on the disposable PostgreSQL.
//
// Overlap is forced, not hoped for: the credit lookup port runs inside each
// transaction right BEFORE the lock, so the lookup stub below parks the first
// caller until the second one has arrived. Both then hit the lock together.
// Without the lock both would read an empty "used" sum and over-apply.
//
// Fixtures (tenant, outlet, price list, tax, cashier/supervisor roles, PIN
// approval) are copied from pos-order.test.ts; no other test file is imported
// except the shared helpers.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  voidPosOrder as voidPosOrderEndpoint,
  type PosReceipt,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10% = Rp55.000 (no service charge, no rounding). */
const ORDER_TOTAL_IDR = 55_000;
/** Full-day window for every weekday, so ordering is open whenever tests run. */
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

let app: Express;

type Member = { client: ReturnType<typeof agent>; userId: string };
type Fixture = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  kopi: string;
  cashier: Member;
  supervisor: Member;
  floor: Staff;
};
type Session = { id: string; guestToken: string };

let a: Fixture;
let b: Fixture;

// ---- Fixtures ---------------------------------------------------------------------

/**
 * Receipt numbering double: only the legend-9pz9 DP sale completes here, so
 * one receipt per order is enough.
 */
const RECEIPT_DEVICE_ID = randomUUID();
const receipts = new Map<string, PosReceipt>();
const receiptPort: PosReceiptPort = {
  async issueForSale(_tx, context, input) {
    const existing = receipts.get(input.orderId);
    if (existing) return existing;
    const sequenceNumber = receipts.size + 1;
    const receipt = {
      id: randomUUID(),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      orderId: input.orderId,
      // No device token in this file; the receipt DTO needs a device id.
      deviceId: input.deviceId ?? RECEIPT_DEVICE_ID,
      number: `DEP1-${String(sequenceNumber).padStart(6, "0")}`,
      sequenceNumber,
      status: "issued",
      issuedAt: input.at.toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    } as unknown as PosReceipt;
    receipts.set(input.orderId, receipt);
    return receipt;
  },
  async findForOrder(_tx, _context, orderId) {
    return receipts.get(orderId) ?? null;
  },
  async voidForOrder() {
    return null;
  },
};

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

async function memberOf(
  tenant: IsolatedTenant,
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
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

/** One isolated tenant with a dine-in price list, tax, staff and a PIN. */
async function seedFixture(label: string): Promise<Fixture> {
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
    cashierRole: randomUUID(),
    supervisorRole: randomUUID(),
  };
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  const cashier = await memberOf(tenant, ids.cashierRole, "POS Kasir");
  const supervisor = await memberOf(
    tenant,
    ids.supervisorRole,
    "POS Supervisor",
  );
  const floor = await staffOfIsolatedTenant(app, tenant);
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Deposit Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    // POS dine-in and QR orders both price from the dine_in list.
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-DEP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    // Default threshold is 0.01%, so any manual discount would need a
    // supervisor. These tests race the reprice, not the approval: allow any
    // manual percent without one.
    await client.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 10000)`,
      [tenant.tenantId],
    );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    kopi: ids.kopi,
    cashier,
    supervisor,
    floor,
  };
}

// ---- Session deposit credit with a deterministic overlap barrier ----------------------

const credits = new Map<string, number>();

type Gate = {
  key: string;
  parties: number;
  arrived: number;
  met: boolean;
  open: Promise<void>;
  release: () => void;
  timeoutMs: number;
};
let gate: Gate | null = null;

function creditKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId.toLowerCase()}`;
}

function setCredit(fx: Fixture, session: Session, amountIdr: number): void {
  credits.set(creditKey(fx.tenant.tenantId, session.id), amountIdr);
}

/**
 * The next two transactions that look up this session's credit wait for each
 * other before they go on to the deposit lock. The timeout is only a safety
 * net (a flow that serializes earlier on another lock must not hang); the
 * invariant assertions hold either way, `met` tells whether the overlap
 * really happened.
 */
function armGate(
  fx: Fixture,
  session: Session,
  timeoutMs = 4_000,
  parties = 2,
): Gate {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate = {
    key: creditKey(fx.tenant.tenantId, session.id),
    parties,
    arrived: 0,
    met: false,
    open,
    release,
    timeoutMs,
  };
  return gate;
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(receiptPort);
  setQrOrderDepositCreditLookup(async (_tx, tenantId, sessionId) => {
    const key = creditKey(tenantId, sessionId);
    const credit = credits.get(key) ?? 0;
    const current = gate;
    // depositFor returns before the lock when there is no credit; only a
    // lookup that goes on to the lock counts as an arrival.
    if (current && current.key === key && credit > 0 && !current.met) {
      current.arrived += 1;
      if (current.arrived >= current.parties) {
        current.met = true;
        current.release();
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        current.open,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, current.timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return credit;
  });
  a = await seedFixture("dep-a");
  b = await seedFixture("dep-b");
});

afterEach(() => {
  credits.clear();
  gate = null;
});

afterAll(async () => {
  setQrOrderDepositCreditLookup(null);
  setPosReceiptPort(null);
  // Orders and audit rows are append-only, so the isolated tenants stay in the
  // disposable database; give them a valid creator so the platform tenant list
  // still parses them.
  for (const fx of [a, b])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      fx.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Table sessions, POS routes, QR guest ---------------------------------------------

/** A real QR scan in a fresh pay-first zone: one open table session. */
async function openSession(fx: Fixture): Promise<Session> {
  const zone = await createZone(
    fx.floor.client,
    { paymentMode: "pay_first", serviceChargeBp: 0, hours: ALL_DAY },
    fx.headers,
  );
  const table = await createTable(
    fx.floor.client,
    { zoneId: zone.id },
    fx.headers,
  );
  const qr = await issueQr(fx.floor.client, table.id, fx.headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: fx.tenant.hostname,
  });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  return {
    id: scanned.body.data.session.id as string,
    guestToken: scanned.body.data.sessionToken as string,
  };
}

function posRoutes(fx: Fixture, who: Member = fx.cashier) {
  const base = `/api/outlets/${encodeURIComponent(fx.tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(fx.headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (session: Session, quantity = 2) =>
      send("", {
        channel: "pos",
        serviceType: "dine_in",
        tableSessionId: session.id,
        items: [{ menuItemId: fx.kopi, quantity, modifierIds: [] }],
      }),
    /** A 10% manual discount: the total shrinks, so the order reprices. */
    discount: (orderId: string) =>
      send(`/${orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp: 1_000,
        reason: "manager_goodwill",
        reasonNote: "Pelanggan tetap",
      }),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
  };
}

async function createDineIn(
  fx: Fixture,
  session: Session,
): Promise<{ id: string; status: string }> {
  const created = await posRoutes(fx).create(session);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  return {
    id: created.body.data.id as string,
    status: created.body.data.status as string,
  };
}

/** The PIN approval of the supervisor for one order void. */
async function voidApproval(
  fx: Fixture,
  orderId: string,
  valueIdr: number,
): Promise<Record<string, string>> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    fx.cashier.userId,
    {
      outletId: fx.tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(fx.supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  // legend-0gy1 moves the approval from a client-invented `approvalRequestId`
  // to the `overrideId` of this very override. The void body is strict, so
  // send whichever of the two the current contract defines; the deposit
  // behaviour under test is the same on both.
  const wantsOverrideId = Object.hasOwn(
    (voidPosOrderEndpoint.body as unknown as { shape: object }).shape,
    "overrideId",
  );
  return wantsOverrideId
    ? { approvedBy: fx.supervisor.userId, overrideId: override.id }
    : { approvedBy: fx.supervisor.userId, approvalRequestId: randomUUID() };
}

type OrderRow = {
  id: string;
  channel: string;
  status: string;
  total: number;
  deposit: number;
};

/** Ground truth from the database: every order of the session. */
async function ordersOf(fx: Fixture, session: Session): Promise<OrderRow[]> {
  const { rows } = await owner.query<{
    id: string;
    channel: string;
    status: string;
    total: string;
    deposit: string;
  }>(
    `SELECT id, channel, status, total_idr::text AS total,
            deposit_applied_idr::text AS deposit
     FROM orders WHERE tenant_id = $1 AND table_session_id = $2
     ORDER BY created_at, id`,
    [fx.tenant.tenantId, session.id],
  );
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    status: row.status,
    total: Number(row.total),
    deposit: Number(row.deposit),
  }));
}

function liveDeposit(rows: OrderRow[]): number {
  return rows
    .filter((row) => row.status !== "voided")
    .reduce((sum, row) => sum + row.deposit, 0);
}

function depositOf(rows: OrderRow[], orderId: string): number {
  const row = rows.find((candidate) => candidate.id === ulidToUuid(orderId));
  if (!row) throw new Error(`Order ${orderId} not in the session`);
  return row.deposit;
}

// ---- Tests ---------------------------------------------------------------------------------

describe("POS session deposit credit (legend-94qt)", () => {
  it("legend-94qt an order takes the session credit up to its total, the next order only what is left", async () => {
    const session = await openSession(a);
    setCredit(a, session, 100_000);
    const first = await createDineIn(a, session);
    const second = await createDineIn(a, session);
    const rows = await ordersOf(a, session);
    // Never above the order total, never above what the session still holds.
    expect(depositOf(rows, first.id)).toBe(ORDER_TOTAL_IDR);
    expect(depositOf(rows, second.id)).toBe(100_000 - ORDER_TOTAL_IDR);
    expect(liveDeposit(rows)).toBe(100_000);
  });

  it("legend-94qt a session without credit applies no deposit and a refused request changes nothing", async () => {
    const session = await openSession(a);
    const order = await createDineIn(a, session);
    expect(depositOf(await ordersOf(a, session), order.id)).toBe(0);
    // Failure case: a discount that is not a valid percent never reprices.
    const refused = await a.cashier.client
      .post(
        `/api/outlets/${a.tenant.outletId}/pos/orders/${order.id}/discounts`,
      )
      .set(a.headers)
      .set(originHeader)
      .send({
        idempotencyKey: randomUUID(),
        source: "manual",
        kind: "percent",
        percentBp: 0,
        reason: "manager_goodwill",
        reasonNote: "Pelanggan tetap",
      });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(liveDeposit(await ordersOf(a, session))).toBe(0);
  });

  it("legend-94qt two concurrent reprices of two orders never apply more deposit than the session holds", async () => {
    const session = await openSession(a);
    // Both orders exist without deposit (no credit yet), so both reprices
    // start from "nothing applied" and want the same credit.
    const first = await createDineIn(a, session);
    const second = await createDineIn(a, session);
    expect(liveDeposit(await ordersOf(a, session))).toBe(0);

    setCredit(a, session, 60_000);
    const overlap = armGate(a, session);
    const [one, two] = await Promise.all([
      posRoutes(a).discount(first.id),
      posRoutes(a).discount(second.id),
    ]);
    expect(one.status, JSON.stringify(one.body)).toBeLessThan(300);
    expect(two.status, JSON.stringify(two.body)).toBeLessThan(300);
    // Both transactions reached the deposit step together: a real race.
    expect(overlap.met).toBe(true);

    const rows = await ordersOf(a, session);
    for (const row of rows) expect(row.deposit).toBeLessThanOrEqual(row.total);
    expect(liveDeposit(rows)).toBeLessThanOrEqual(60_000);
    // And the credit is fully used, not left on the table by the serialization.
    expect(liveDeposit(rows)).toBe(
      Math.min(
        60_000,
        rows.reduce((sum, row) => sum + row.total, 0),
      ),
    );
  });

  it("legend-94qt a POS create racing a QR pay-first checkout never applies the same credit twice", async () => {
    const session = await openSession(a);
    const guest = (path: string) =>
      agent(app)
        .post(`/api/table-sessions/${session.id}${path}`)
        .set(a.headers)
        .set("Authorization", `Bearer ${session.guestToken}`)
        .set(originHeader);
    const added = await guest("/cart/lines").send({
      idempotencyKey: randomUUID(),
      menuItemId: a.kopi,
      quantity: 2,
      modifierIds: [],
      expectedCartVersion: 0,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const version = added.body.data.cart.version as number;

    setCredit(a, session, 60_000);
    // Short net: the POS create takes the table lock first, which may keep the
    // two from meeting at the barrier; the invariant is asserted regardless.
    armGate(a, session, 1_500);
    const [pos, qr] = await Promise.all([
      posRoutes(a).create(session),
      guest("/orders").send({
        expectedCartVersion: version,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(pos.status, JSON.stringify(pos.body)).toBe(201);
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);

    const rows = await ordersOf(a, session);
    expect(rows.map((row) => row.channel).sort()).toEqual(["pos", "qr"]);
    for (const row of rows) expect(row.deposit).toBeLessThanOrEqual(row.total);
    expect(liveDeposit(rows)).toBeLessThanOrEqual(60_000);
    expect(liveDeposit(rows)).toBe(60_000);
  });

  it("legend-94qt voiding an order releases its deposit and the other order can then take it", async () => {
    const session = await openSession(a);
    setCredit(a, session, 60_000);
    const first = await createDineIn(a, session);
    const second = await createDineIn(a, session);
    let rows = await ordersOf(a, session);
    expect(depositOf(rows, first.id)).toBe(ORDER_TOTAL_IDR);
    expect(depositOf(rows, second.id)).toBe(60_000 - ORDER_TOTAL_IDR);

    const body = {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      expectedStatus: first.status,
    };
    // Failure case: an approval worth less than the order refuses the void and
    // the deposit stays where it was.
    const small = await voidApproval(a, first.id, ORDER_TOTAL_IDR - 1);
    const refused = await posRoutes(a).voidOrder(first.id, {
      ...body,
      ...small,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    rows = await ordersOf(a, session);
    expect(depositOf(rows, first.id)).toBe(ORDER_TOTAL_IDR);

    const approval = await voidApproval(a, first.id, ORDER_TOTAL_IDR);
    const voided = await posRoutes(a).voidOrder(first.id, {
      ...body,
      ...approval,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
    expect(voided.body.data.status).toBe("voided");
    rows = await ordersOf(a, session);
    expect(depositOf(rows, first.id)).toBe(0);
    expect(liveDeposit(rows)).toBe(60_000 - ORDER_TOTAL_IDR);

    // The second order reprices (10% off) and now covers its whole new total
    // from the released credit instead of the Rp5.000 it held.
    const repriced = await posRoutes(a).discount(second.id);
    expect(repriced.status, JSON.stringify(repriced.body)).toBeLessThan(300);
    rows = await ordersOf(a, session);
    const live = rows.find((row) => row.id === ulidToUuid(second.id))!;
    expect(live.total).toBeLessThan(ORDER_TOTAL_IDR);
    expect(live.deposit).toBe(live.total);
    expect(liveDeposit(rows)).toBeLessThanOrEqual(60_000);
  });

  it("legend-94qt another tenant's session credit is untouched and unreachable", async () => {
    const sessionB = await openSession(b);
    setCredit(b, sessionB, 40_000);
    const orderB = await createDineIn(b, sessionB);
    expect(depositOf(await ordersOf(b, sessionB), orderB.id)).toBe(40_000);

    // Tenant A runs the same race and a void on its own session.
    const sessionA = await openSession(a);
    const first = await createDineIn(a, sessionA);
    const second = await createDineIn(a, sessionA);
    setCredit(a, sessionA, 60_000);
    armGate(a, sessionA);
    await Promise.all([
      posRoutes(a).discount(first.id),
      posRoutes(a).discount(second.id),
    ]);
    const rowsA = await ordersOf(a, sessionA);
    // B's Rp40.000 never reduces what A's session may apply.
    expect(liveDeposit(rowsA)).toBe(
      Math.min(
        60_000,
        rowsA.reduce((sum, row) => sum + row.total, 0),
      ),
    );

    // A's cashier cannot reach B's order by id: not found, and nothing moves.
    const foreign = await posRoutes(a).discount(orderB.id);
    expect(foreign.status).toBe(404);

    const rowsB = await ordersOf(b, sessionB);
    expect(depositOf(rowsB, orderB.id)).toBe(40_000);
    expect(rowsB[0]?.total).toBe(ORDER_TOTAL_IDR);
    expect(rowsB[0]?.status).not.toBe("voided");
  });
});

// legend-9pz9: a sale settled by the reservation DP completes and its
// order.paid carries the DP as `paidDepositIdr` (before: 409 CONFLICT).
describe("POS sale settled by the session deposit (legend-9pz9)", () => {
  /** draft -> sent, so the order can complete. */
  async function sent(fx: Fixture, order: { id: string; status: string }) {
    if (order.status !== "draft") return order.status;
    const submitted = await posRoutes(fx).submit(order.id, order.status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return submitted.body.data.status as string;
  }

  async function paidEvents(fx: Fixture, orderId: string) {
    const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
         AND event->'payload'->>'orderId' = $2`,
      [fx.tenant.tenantId, orderId],
    );
    return rows.map((row) => row.payload);
  }

  it("legend-9pz9 a sale fully covered by the DP completes without a tender and emits order.paid with paidDepositIdr", async () => {
    const session = await openSession(a);
    setCredit(a, session, 100_000);
    const order = await createDineIn(a, session);
    expect(depositOf(await ordersOf(a, session), order.id)).toBe(
      ORDER_TOTAL_IDR,
    );
    const status = await sent(a, order);
    const completed = await posRoutes(a).complete(order.id, status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.data.status).toBe("completed");
    const events = await paidEvents(a, order.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      totalIdr: ORDER_TOTAL_IDR,
      paidDepositIdr: ORDER_TOTAL_IDR,
      paidCashIdr: 0,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [],
    });
  });

  it("legend-9pz9 a completed sale paid with the DP is refused a linked void (refund instead)", async () => {
    const session = await openSession(a);
    setCredit(a, session, 100_000);
    const order = await createDineIn(a, session);
    const status = await sent(a, order);
    const completed = await posRoutes(a).complete(order.id, status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    // The void pays back only captured cash and books the full total, so the
    // DP would vanish: refused before any approval is consumed.
    const voided = await posRoutes(a).correctionVoid(order.id, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      ...(await voidApproval(a, order.id, ORDER_TOTAL_IDR)),
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(409);
    expect(voided.body.error?.code ?? voided.body.code).toBe("CONFLICT");
    expect(JSON.stringify(voided.body)).toMatch(/refund/);
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pos_order_voids
       WHERE tenant_id = $1 AND order_id = $2`,
      [a.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("legend-9pz9 a sale part-covered by the DP still needs tenders for the rest", async () => {
    const session = await openSession(a);
    setCredit(a, session, 20_000);
    const order = await createDineIn(a, session);
    expect(depositOf(await ordersOf(a, session), order.id)).toBe(20_000);
    const status = await sent(a, order);
    // The balance check stays: DP + captured tenders must equal the total.
    const refused = await posRoutes(a).complete(order.id, status);
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code ?? refused.body.code).toBe(
      "TENDER_TOTAL_MISMATCH",
    );
    expect(await paidEvents(a, order.id)).toHaveLength(0);
    const [row] = (await ordersOf(a, session)).filter(
      (candidate) => candidate.id === ulidToUuid(order.id),
    );
    expect(row?.status).not.toBe("completed");
  });
});
