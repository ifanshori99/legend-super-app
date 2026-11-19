// Brief 1113, finding P1 (second opinion 1094/1112): creating an order issue
// (POST /api/outlets/:outletId/orders/:orderId/issues) on a shared tablet must
// not record money out.
//
// Spec (docs/briefs/1113-fix-akses-1094-so.md, CTO decision 1):
//  - On a shared tablet, a report that carries ANY resolution (manual_refund,
//    voucher, swap) is refused 403 SHARED_DEVICE_SCREEN_CLOSED, before the
//    service runs: no order_issues row, no approval spent.
//  - A report without a resolution (log only) still succeeds on the tablet.
//  - A personal device is unchanged: the same body is never answered with
//    SHARED_DEVICE_SCREEN_CLOSED (the normal rules decide).
//  - Money, access: when in doubt, refuse.
//
// Assumptions (spec silent):
//  - The refusal precedes the service, so the order and item need not exist for
//    the refused cases; a real paid order is used for the control cases.
//  - The tablet login owner is tenant-wide with the same permissions as the
//    cashier (only the shared-tablet rule can refuse).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantIdSchema, uuidToUlid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const PERMISSIONS = ["order.view", "kds.remake_comp.record"];

type Person = { client: ReturnType<typeof agent>; userId: string };
type Response = { status: number; body: unknown };

let w: World;
let outletA: string;
let roleId: string;
let cashier: Person;
/** Login of the current test (tenant-wide, fresh per test). */
let session: Person;
const devices = new Map<string, string>();
let sharedDevice: string;

beforeAll(async () => {
  w = await createWorld();
  outletA = w.tenant.outletId;
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId ? (devices.get(deviceId) ?? null) : null,
  );
  roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Isu 1113', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, w.tenant.tenantId, JSON.stringify(PERMISSIONS)],
  );
  cashier = await makeUser("Kasir Isu 1113", { outletId: outletA });
  sharedDevice = await newDevice(outletA);
}, 120_000);

beforeEach(async () => {
  session = await makeUser("Login Tablet Isu 1113", null);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await w.teardown();
});

// ---- fixtures ----------------------------------------------------------------

async function makeUser(
  label: string,
  scope: { outletId: string } | null,
): Promise<Person> {
  const client = agent(w.app);
  await signUp(client, label);
  const me = await client.get("/api/auth/get-session");
  const userId = me.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      w.tenant.tenantId,
      userId,
      roleId,
      scope ? "outlet" : "tenant",
      scope?.outletId ?? null,
    ],
  );
  return { client, userId };
}

/** A shared-mode POS tablet registered at the outlet. */
async function newDevice(outletId: string): Promise<string> {
  const id = randomUUID();
  devices.set(id, outletId);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
    [id, w.tenant.tenantId, outletId, `Tablet 1113 ${id.slice(0, 6)}`],
  );
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

/** The cashier signs in with a PIN on the shared tablet. */
async function cashierToken(): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    { outletId: outletA, userId: cashier.userId },
    { pin: PIN },
  );
  const response = await session.client
    .post("/api/staff-pins/pos-session")
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(sharedDevice))
    .send({ userId: cashier.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

type Target = { orderId: string; orderItemId: string };

/** A real paid order line (control cases) or an unknown one (refused cases). */
async function realTarget(): Promise<Target> {
  const { order, roti } = await w.paidOrder();
  return {
    orderId: order.id,
    orderItemId: roti.id,
  };
}

const unknownTarget = (): Target => ({
  orderId: uuidToUlid(randomUUID()),
  orderItemId: uuidToUlid(randomUUID()),
});

function issueBody(target: Target, patch: Record<string, unknown>) {
  return {
    orderItemId: target.orderItemId,
    type: "complaint",
    reason: "complaint",
    reasonNote: "Pelanggan kecewa, dicatat oleh kasir",
    stationId: null,
    employeeId: null,
    resolution: null,
    voucherId: null,
    approvedBy: null,
    idempotencyKey: `iss-${randomUUID()}`,
    ...patch,
  };
}

const RESOLUTIONS: Record<string, Record<string, unknown>> = {
  manual_refund: {
    resolution: "manual_refund",
    approvedBy: randomUUID(),
    overrideId: uuidToUlid(randomUUID()),
  },
  voucher: { resolution: "voucher", voucherId: randomUUID() },
  swap: { resolution: "swap", replacementItemId: randomUUID() },
};

function report(
  target: Target,
  patch: Record<string, unknown>,
  call: { deviceId?: string; token?: string },
): Promise<Response> {
  let request = session.client
    .post(`/api/outlets/${outletA}/orders/${target.orderId}/issues`)
    .set(w.headers)
    .set(originHeader);
  if (call.deviceId)
    request = request.set(DEVICE_TOKEN_HEADER, tokenOf(call.deviceId));
  if (call.token) request = request.set(ACTING_HEADER, call.token);
  return request.send(issueBody(target, patch));
}

async function counts(): Promise<{ issues: number; approvals: number }> {
  const issues = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM order_issues WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  const approvals = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM pos_order_approval_uses WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return {
    issues: Number(issues.rows[0]!.n),
    approvals: Number(approvals.rows[0]!.n),
  };
}

const errorCode = (response: Response) =>
  (response.body as { error?: { code?: string } }).error?.code;

// ---- tests -------------------------------------------------------------------

describe("order issue creation on a shared tablet (brief 1113, P1)", () => {
  for (const [name, patch] of Object.entries(RESOLUTIONS)) {
    it(`${name} with a cashier token: 403 SHARED_DEVICE_SCREEN_CLOSED, nothing written or spent`, async () => {
      const token = await cashierToken();
      const before = await counts();
      const response = await report(unknownTarget(), patch, {
        deviceId: sharedDevice,
        token,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(errorCode(response)).toBe(ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED);
      expect(await counts()).toEqual(before);
    });
  }

  it("a log-only report (no resolution) still succeeds on the tablet", async () => {
    const target = await realTarget();
    const token = await cashierToken();
    const response = await report(
      target,
      {},
      {
        deviceId: sharedDevice,
        token,
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("a personal device is unchanged: the tablet rule never answers", async () => {
    for (const patch of Object.values(RESOLUTIONS)) {
      const response = await report(unknownTarget(), patch, {});
      expect(errorCode(response)).not.toBe(
        ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED,
      );
    }
    const target = await realTarget();
    const response = await report(target, {}, {});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});
