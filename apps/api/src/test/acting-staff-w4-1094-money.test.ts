// Acting staff wave 4, money routes on a shared tablet (brief 1094, card
// legend-13vhb): apology vouchers (POST /api/apology-vouchers) and delivery
// orders (POST /api/outlets/:outletId/delivery-orders/manual and
// .../:id/status). Fail-first tests; the card puts these routers behind
// resolveActingStaff + requireActingStaffOnSharedDevice.
//
// Contract (CTO decision 18 Nov, 1054): a money action on a shared (flagged)
// tablet REQUIRES a cashier PIN token (X-Acting-Staff).
//  - flagged device, no token: 401 ACTING_STAFF_REQUIRED, nothing is written.
//  - flagged device, garbage token: 401 ACTING_STAFF_INVALID, nothing written.
//  - flagged device, valid cashier token: passes and the cashier, not the
//    tablet login owner, is the recorded actor.
//  - private (unflagged) device or plain browser: unchanged, the session
//    owner stays the actor.
//  - a cashier of outlet B never acts on outlet A's records (fail closed).
//
// Round 2 (architect findings, "refuse when in doubt"):
//  - delivery orders stay CLOSED on a shared tablet: 403
//    SHARED_DEVICE_SCREEN_CLOSED, checked BEFORE the PIN, so the answer is the
//    same with no token, a garbage token and a valid cashier token. The PIN
//    guard + actorOf stay behind it as a backup layer (not reachable by the
//    tests). Private devices and plain browsers are unchanged.
//  - a voucher route has no :outletId. When a PIN token is present, the
//    outlet of the issue must equal the outlet of the token: otherwise 403
//    ACTING_STAFF_OUTLET_MISMATCH. A cashier staffed at both outlets (two-outlet cashier)
//    signed in on outlet A's tablet cannot issue a voucher for outlet B's
//    issue. No token (plain browser): unchanged.
//
// Assumptions:
//  - Same codes as acting-staff-w3-recovery: ACTING_STAFF_REQUIRED /
//    ACTING_STAFF_INVALID, status 401 (shared ACTING_STAFF_ERROR_CODES).
//  - The brief lists comp / collect-at-pos / waive too; those live in routers
//    this card does not touch (order-recovery-charge is off limits), so only
//    the apology voucher and delivery-orders mutations are covered here.
//  - Voucher actor = `issuedBy` of the response (apologyVoucherSchema).
//    Delivery actor evidence = actor-ish columns of the delivery_channel_orders
//    row plus every audit_logs / domain_event_outbox row that mentions the
//    order id (the calibration test proves the helper sees the session owner).
//  - Status steps (accepted -> preparing) are asserted by gate behavior and
//    resulting status only, because the actor evidence for a step is not
//    named by the contract.
//  - "Cashier of outlet B refused": either the PIN sign-in on outlet A's
//    tablet is refused (4xx), or, if a token is issued, the money call with
//    it is refused (4xx) and nothing is written. Either way nothing is
//    written for outlet A. The plain-browser case of a B-scoped user is a
//    403/404.
//  - Round 2: the outlet-B issue is made by reporting an issue on outlet A's
//    order and moving order_issues.outlet_id to outlet B in SQL (no helper
//    reports at outlet B). The check is by the issue's own outlet.
//  - Session owner = fresh user per test with the money role scoped to the
//    main outlet (a call on a flagged device marks the login session for
//    good). Setup reports/orders use the world's tenant-wide supervisor.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner, type Staff } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const REASON = "Roti habis, mohon maaf atas ketidaknyamanan";
const VOUCHER_IDR = 20_000;
const KOPI_IDR = 25_000;
const MONEY_PERMISSIONS = [
  "order.view",
  "order.create",
  "order.recovery.handle",
  "order.apology_voucher.issue",
  "kds.ticket.process",
  "kds.remake_comp.record",
  "floor.table.view",
  "delivery.order.handle",
];

let w: World;
let moneyRoleId: string;
/** Tablet login of the current test (fresh per test, see Assumptions). */
let session: Staff;
/** PIN cashier of the main outlet (A) and of the other outlet (B). */
let cashierA: Staff;
let cashierB: Staff;
/** PIN cashier staffed at BOTH outlets (round 2). */
let cashierAB: Staff;
const devices = new Set<string>();

const outletA = () => w.tenant.outletId;
const outletB = () => w.ids.otherOutlet;
const deliveryBase = () => `/api/outlets/${encodeURIComponent(outletA())}`;

type Response = { status: number; body: unknown };

async function userAt(outletId: string, label: string): Promise<Staff> {
  const client = agent(w.app);
  const email = await signUp(client, label);
  const me = await client.get("/api/auth/get-session");
  const userId = me.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, userId, moneyRoleId, outletId],
  );
  return { client, userId, email };
}

beforeAll(async () => {
  w = await createWorld();
  moneyRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Uang Uji', false, NULL, $3, false, '["tenant","outlet"]')`,
    [moneyRoleId, w.tenant.tenantId, JSON.stringify(MONEY_PERMISSIONS)],
  );
  cashierA = await userAt(outletA(), "Kasir Uang A");
  cashierB = await userAt(outletB(), "Kasir Uang B");
  cashierAB = await userAt(outletA(), "Kasir Uang A+B");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, cashierAB.userId, moneyRoleId, outletB()],
  );
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId && devices.has(deviceId) ? outletA() : null,
  );

  // Delivery setup: one gofood channel at outlet A priced for the coffee item.
  const priceListId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'gofood', '2026-01-01')`,
      [priceListId, w.tenant.tenantId, outletA()],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), w.tenant.tenantId, priceListId, w.ids.kopi, KOPI_IDR],
    );
    await db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, 'gofood', $3, 2000, true)`,
      [w.tenant.tenantId, outletA(), `store-${randomUUID().slice(0, 8)}`],
    );
  });
}, 120_000);

beforeEach(async () => {
  session = await userAt(outletA(), "Tablet Login Uang");
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await w.teardown();
});

async function newDevice(flagged: boolean): Promise<string> {
  const id = randomUUID();
  devices.add(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, w.tenant.tenantId, outletA(), `Kasir Uang ${id.slice(0, 6)}`],
  );
  if (flagged)
    await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
      id,
    ]);
  return id;
}

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

function tenantContext() {
  return establishTenantContext({
    tenantId: tenantIdSchema.parse(w.tenant.tenantId),
    brandId: null,
    source: "session",
  });
}

/** PIN sign-in of `cashier` (staff of `cashierOutletId`) on a tablet. */
async function posSession(
  deviceId: string,
  cashier: Staff,
  cashierOutletId: string,
) {
  await setStaffPin(
    tenantContext(),
    cashier.userId,
    { outletId: cashierOutletId, userId: cashier.userId },
    { pin: PIN },
  );
  return session.client
    .post("/api/staff-pins/pos-session")
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: cashier.userId, pin: PIN });
}

async function cashierToken(
  deviceId: string,
  cashier: Staff = cashierA,
): Promise<string> {
  const response = await posSession(deviceId, cashier, outletA());
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** A POST as the tablet login; `deviceId` null = plain browser. */
function post(
  path: string,
  body: Record<string, unknown>,
  deviceId: string | null,
  token?: string,
  headers: Record<string, string> = {},
  who: Staff = session,
) {
  let request = who.client.post(path).set(w.headers).set(originHeader);
  if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceId));
  if (token) request = request.set(ACTING_HEADER, token);
  return request.set(headers).send(body);
}

function expectError(response: Response, status: number, code: string) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

function expectClosed(response: Response) {
  expectError(response, 403, "SHARED_DEVICE_SCREEN_CLOSED");
}

function expectRefused(response: Response) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    400,
  );
  expect(response.status).toBeLessThan(500);
}

// ---------------------------------------------------------------- vouchers

async function failedIssue(): Promise<string> {
  const paid = await w.paidOrder();
  const reported = await w.report(paid.roti.id);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return reported.body.data.id as string;
}

const voucherBody = (issueId: string) => ({
  valueIdr: VOUCHER_IDR,
  reason: REASON,
  orderIssueId: issueId,
});

const issueVoucher = (
  issueId: string,
  deviceId: string | null,
  token?: string,
  who: Staff = session,
) =>
  post("/api/apology-vouchers", voucherBody(issueId), deviceId, token, {}, who);

async function voucherCount(issueId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM apology_vouchers WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return Number(rows[0]!.n);
}

async function voucherIssuer(issueId: string): Promise<string> {
  const { rows } = await owner.query<{ issued_by: string }>(
    "SELECT issued_by FROM apology_vouchers WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return String(rows[0]?.issued_by);
}

/** A failed-item issue that belongs to outlet B (see Assumptions). */
async function failedIssueOfOutletB(): Promise<string> {
  const issueId = await failedIssue();
  await owner.query(
    "UPDATE order_issues SET outlet_id = $3 WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId, outletB()],
  );
  return issueId;
}

describe("acting staff on apology vouchers (wave 4)", () => {
  // Calibration: a plain browser keeps the session owner as the issuer.
  it("no device, no header: the voucher is issued by the session owner", async () => {
    const issueId = await failedIssue();
    const response = await issueVoucher(issueId, null);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(
      (response.body as { data: { issuedBy: string } }).data.issuedBy,
    ).toBe(session.userId);
    expect(await voucherIssuer(issueId)).toBe(session.userId);
  });

  it("shared tablet without a PIN token: 403 SHARED_DEVICE_SCREEN_CLOSED, no voucher is created", async () => {
    const deviceId = await newDevice(true);
    const issueId = await failedIssue();
    expectClosed(await issueVoucher(issueId, deviceId));
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("shared tablet with a garbage token: 403 SHARED_DEVICE_SCREEN_CLOSED (checked before the PIN), no voucher is created", async () => {
    const deviceId = await newDevice(true);
    const issueId = await failedIssue();
    expectClosed(await issueVoucher(issueId, deviceId, "pas_garbage-token"));
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("shared tablet with a valid cashier token: still 403 SHARED_DEVICE_SCREEN_CLOSED, no voucher is created", async () => {
    const deviceId = await newDevice(true);
    const issueId = await failedIssue();
    const token = await cashierToken(deviceId);
    expectClosed(await issueVoucher(issueId, deviceId, token));
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("private (unflagged) device without a token: works, the owner is the issuer", async () => {
    const deviceId = await newDevice(false);
    const issueId = await failedIssue();
    const response = await issueVoucher(issueId, deviceId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await voucherIssuer(issueId)).toBe(session.userId);
  });

  it("cashier of outlet B cannot sign in on outlet A's tablet or issue a voucher for outlet A", async () => {
    const deviceId = await newDevice(true);
    const issueId = await failedIssue();
    const signIn = await posSession(deviceId, cashierB, outletB());
    if (signIn.status === 201) {
      const response = await issueVoucher(
        issueId,
        deviceId,
        signIn.body.data.token as string,
      );
      expectRefused(response);
    } else {
      expectRefused(signIn);
    }
    expect(await voucherCount(issueId)).toBe(0);
  });

  // Round 3 (CTO, brief 1120): vouchers are closed on a shared tablet, so the
  // OUTLET_MISMATCH coverage runs on a registered, NOT shared device (flag off).
  it("two-outlet cashier with an outlet A token on a non-shared device: voucher for an outlet A issue is issued by the cashier", async () => {
    const deviceId = await newDevice(false);
    const issueId = await failedIssue();
    const token = await cashierToken(deviceId, cashierAB);
    const response = await issueVoucher(issueId, deviceId, token);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await voucherIssuer(issueId)).toBe(cashierAB.userId);
  });

  it("two-outlet cashier with an outlet A token on a non-shared device: voucher for an outlet B issue is 403 ACTING_STAFF_OUTLET_MISMATCH, no voucher", async () => {
    const deviceId = await newDevice(false);
    const issueId = await failedIssueOfOutletB();
    const token = await cashierToken(deviceId, cashierAB);
    expectError(
      await issueVoucher(issueId, deviceId, token),
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
    );
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("a user limited to outlet B cannot issue a voucher for outlet A's issue in a plain browser", async () => {
    const issueId = await failedIssue();
    const response = await issueVoucher(issueId, null, undefined, cashierB);
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await voucherCount(issueId)).toBe(0);
  });
});

// ---------------------------------------------------------- delivery orders

const manualBody = (externalOrderId = `M-${randomUUID().slice(0, 8)}`) => ({
  platform: "gofood",
  externalOrderId,
  lines: [{ menuItemId: w.ids.kopi, quantity: 1 }],
});

const manualOrder = (
  deviceId: string | null,
  token?: string,
  who: Staff = session,
  body: Record<string, unknown> = manualBody(),
) =>
  post(
    `${deliveryBase()}/delivery-orders/manual`,
    body,
    deviceId,
    token,
    { "Idempotency-Key": randomUUID() },
    who,
  );

const setStatus = (
  orderId: string,
  status: string,
  deviceId: string | null,
  token?: string,
  who: Staff = session,
) =>
  post(
    `${deliveryBase()}/delivery-orders/${orderId}/status`,
    { status },
    deviceId,
    token,
    { "Idempotency-Key": randomUUID() },
    who,
  );

async function deliveryOrderCount(externalOrderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM delivery_channel_orders WHERE tenant_id = $1 AND external_order_id = $2",
    [w.tenant.tenantId, externalOrderId],
  );
  return Number(rows[0]!.n);
}

async function deliveryStatus(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM delivery_channel_orders WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, orderId],
  );
  return rows[0]!.status;
}

/** Actor evidence of one delivery order (see Assumptions). */
async function actorEvidence(orderId: string): Promise<string> {
  const row = await owner.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(t) AS row FROM delivery_channel_orders t WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, orderId],
  );
  const columns = Object.entries(row.rows[0]?.row ?? {})
    .filter(([key]) =>
      /(accepted_by|created_by|updated_by|actor|handled_by)/i.test(key),
    )
    .map(([, value]) => String(value));
  const audit = await owner.query<{ event: unknown }>(
    `SELECT event FROM audit_logs WHERE tenant_id = $1 AND event::text LIKE $2`,
    [w.tenant.tenantId, `%${orderId}%`],
  );
  const outbox = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE $2`,
    [w.tenant.tenantId, `%${orderId}%`],
  );
  return [
    ...columns,
    ...audit.rows.map((r) => JSON.stringify(r.event)),
    ...outbox.rows.map((r) => JSON.stringify(r.event)),
  ].join("\n");
}

/** An accepted manual order created in a plain browser by another user. */
async function acceptedOrder(): Promise<string> {
  const setup = await userAt(outletA(), "Setup Delivery");
  const created = await manualOrder(null, undefined, setup);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body as { data: { id: string } }).data.id;
}

describe("acting staff on delivery orders (wave 4)", () => {
  // Calibration: a plain browser keeps the session owner as the actor.
  it("no device, no header: a manual order records the session owner", async () => {
    const response = await manualOrder(null);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    const evidence = await actorEvidence(id);
    expect(evidence).toContain(session.userId);
    expect(evidence).not.toContain(cashierA.userId);
  });

  describe("manual order (POST .../delivery-orders/manual)", () => {
    it("shared tablet without a PIN token: 403 SHARED_DEVICE_SCREEN_CLOSED, no order is created", async () => {
      const deviceId = await newDevice(true);
      const body = manualBody();
      expectClosed(await manualOrder(deviceId, undefined, session, body));
      expect(await deliveryOrderCount(body.externalOrderId)).toBe(0);
    });

    it("shared tablet with a garbage token: 403 SHARED_DEVICE_SCREEN_CLOSED (checked before the PIN), no order is created", async () => {
      const deviceId = await newDevice(true);
      const body = manualBody();
      expectClosed(
        await manualOrder(deviceId, "pas_garbage-token", session, body),
      );
      expect(await deliveryOrderCount(body.externalOrderId)).toBe(0);
    });

    it("shared tablet with a valid cashier token: still 403 SHARED_DEVICE_SCREEN_CLOSED, no order is created", async () => {
      const deviceId = await newDevice(true);
      const token = await cashierToken(deviceId);
      const body = manualBody();
      expectClosed(await manualOrder(deviceId, token, session, body));
      expect(await deliveryOrderCount(body.externalOrderId)).toBe(0);
    });

    it("private (unflagged) device without a token: works, the owner is the actor", async () => {
      const deviceId = await newDevice(false);
      const response = await manualOrder(deviceId);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const id = (response.body as { data: { id: string } }).data.id;
      const evidence = await actorEvidence(id);
      expect(evidence).toContain(session.userId);
      expect(evidence).not.toContain(cashierA.userId);
    });

    it("cashier of outlet B cannot sign in on outlet A's tablet or create an order for outlet A", async () => {
      const deviceId = await newDevice(true);
      const body = manualBody();
      const signIn = await posSession(deviceId, cashierB, outletB());
      if (signIn.status === 201) {
        expectRefused(
          await manualOrder(
            deviceId,
            signIn.body.data.token as string,
            session,
            body,
          ),
        );
      } else {
        expectRefused(signIn);
      }
      expect(await deliveryOrderCount(body.externalOrderId)).toBe(0);
    });

    it("a user limited to outlet B cannot create an order for outlet A in a plain browser", async () => {
      const body = manualBody();
      const response = await manualOrder(null, undefined, cashierB, body);
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await deliveryOrderCount(body.externalOrderId)).toBe(0);
    });
  });

  describe("status step (POST .../delivery-orders/:id/status)", () => {
    it("shared tablet without a PIN token: 403 SHARED_DEVICE_SCREEN_CLOSED, the status is unchanged", async () => {
      const deviceId = await newDevice(true);
      const id = await acceptedOrder();
      expectClosed(await setStatus(id, "preparing", deviceId));
      expect(await deliveryStatus(id)).toBe("accepted");
    });

    it("shared tablet with a garbage token: 403 SHARED_DEVICE_SCREEN_CLOSED (checked before the PIN), the status is unchanged", async () => {
      const deviceId = await newDevice(true);
      const id = await acceptedOrder();
      expectClosed(
        await setStatus(id, "preparing", deviceId, "pas_garbage-token"),
      );
      expect(await deliveryStatus(id)).toBe("accepted");
    });

    it("shared tablet with a valid cashier token: still 403 SHARED_DEVICE_SCREEN_CLOSED, the status is unchanged", async () => {
      const deviceId = await newDevice(true);
      const id = await acceptedOrder();
      const token = await cashierToken(deviceId);
      expectClosed(await setStatus(id, "preparing", deviceId, token));
      expect(await deliveryStatus(id)).toBe("accepted");
    });

    it("private (unflagged) device without a token: works", async () => {
      const deviceId = await newDevice(false);
      const id = await acceptedOrder();
      const response = await setStatus(id, "preparing", deviceId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await deliveryStatus(id)).toBe("preparing");
    });

    it("cashier of outlet B cannot move outlet A's order on outlet A's tablet", async () => {
      const deviceId = await newDevice(true);
      const id = await acceptedOrder();
      const signIn = await posSession(deviceId, cashierB, outletB());
      if (signIn.status === 201) {
        expectRefused(
          await setStatus(
            id,
            "preparing",
            deviceId,
            signIn.body.data.token as string,
          ),
        );
      } else {
        expectRefused(signIn);
      }
      expect(await deliveryStatus(id)).toBe("accepted");
    });

    it("a user limited to outlet B cannot move outlet A's order in a plain browser", async () => {
      const id = await acceptedOrder();
      const response = await setStatus(
        id,
        "preparing",
        null,
        undefined,
        cashierB,
      );
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await deliveryStatus(id)).toBe("accepted");
    });
  });
});
