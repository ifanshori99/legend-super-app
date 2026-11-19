// Brief 1120, "Tambahan CTO" (architect delta on 1094, P1): issuing an apology
// voucher (POST /api/apology-vouchers) on a shared tablet is a money-out
// shortcut. With an orderIssueId it issues the voucher AND resolves the issue,
// which is the same voucher resolution that is already closed with 403 on the
// tablet.
//
// Spec (docs/briefs/1120-akses-outlet-order-recovery-cq0u7.md, CTO decision):
//  - On a shared tablet, POST /api/apology-vouchers is refused 403
//    SHARED_DEVICE_SCREEN_CLOSED for EVERY body shape (with or without
//    orderIssueId), with or without a cashier token.
//  - Refused means: no voucher row is written and the order issue stays 'open'.
//  - A personal device is unchanged: the same request still succeeds.
//  - Money, access: when in doubt, refuse.
//
// Assumptions (spec silent):
//  - Value Rp20.000 is below the apology_voucher approval floor, so a personal
//    device call needs no approval and returns 201.
//  - Personal-device standalone voucher (no orderIssueId) uses an outlet-scoped
//    login so the outlet is unambiguous; it needs an Idempotency-Key.
//  - The tablet login owner is tenant-wide with the cashier's permissions
//    (only the shared-tablet rule can refuse).
//  - The refused standalone call carries an Idempotency-Key too, so a missing
//    key can not be the reason for a refusal.
//  - order_issues.status holds the text 'open' for a fresh issue.

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
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const PERMISSIONS = ["order.view", "order.apology_voucher.issue"];
const REASON = "Roti habis, mohon maaf atas ketidaknyamanan";
const VALUE_IDR = 20_000;

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
     VALUES ($1, $2, 'Kasir Voucher 1120', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, w.tenant.tenantId, JSON.stringify(PERMISSIONS)],
  );
  cashier = await makeUser("Kasir Voucher 1120", { outletId: outletA });
  sharedDevice = await newDevice(outletA);
}, 120_000);

beforeEach(async () => {
  session = await makeUser("Login Tablet Voucher 1120", null);
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
    [id, w.tenant.tenantId, outletId, `Tablet 1120 ${id.slice(0, 6)}`],
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

/** A real open order issue (reported by the kitchen supervisor). */
async function openIssue(): Promise<string> {
  const paid = await w.paidOrder();
  const reported = await w.report(paid.roti.id);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return reported.body.data.id as string;
}

type Call = { who: Person; deviceId?: string; token?: string };

function issueVoucher(
  body: Record<string, unknown>,
  call: Call,
): Promise<Response> {
  let request = call.who.client
    .post("/api/apology-vouchers")
    .set(w.headers)
    .set(originHeader);
  if (body.orderIssueId === undefined)
    request = request.set("Idempotency-Key", randomUUID());
  if (call.deviceId)
    request = request.set(DEVICE_TOKEN_HEADER, tokenOf(call.deviceId));
  if (call.token) request = request.set(ACTING_HEADER, call.token);
  return request.send(body);
}

async function voucherRows(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM apology_vouchers WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function issueStatus(issueId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.status;
}

const errorCode = (response: Response) =>
  (response.body as { error?: { code?: string } }).error?.code;

// ---- tests -------------------------------------------------------------------

describe("apology voucher on a shared tablet (brief 1120, CTO addendum)", () => {
  for (const withToken of [true, false]) {
    const who = withToken ? "with a cashier token" : "without a cashier token";

    it(`with orderIssueId ${who}: 403 SHARED_DEVICE_SCREEN_CLOSED, no voucher, issue stays open`, async () => {
      const issueId = await openIssue();
      const token = withToken ? await cashierToken() : undefined;
      const before = await voucherRows();

      const response = await issueVoucher(
        { valueIdr: VALUE_IDR, reason: REASON, orderIssueId: issueId },
        { who: session, deviceId: sharedDevice, token },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(errorCode(response)).toBe(ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED);
      expect(await voucherRows()).toBe(before);
      expect(await issueStatus(issueId)).toBe("open");
    });

    it(`without orderIssueId ${who}: 403 SHARED_DEVICE_SCREEN_CLOSED, no voucher`, async () => {
      const token = withToken ? await cashierToken() : undefined;
      const before = await voucherRows();

      const response = await issueVoucher(
        { valueIdr: VALUE_IDR, reason: REASON },
        { who: session, deviceId: sharedDevice, token },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(errorCode(response)).toBe(ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED);
      expect(await voucherRows()).toBe(before);
    });
  }

  it("a personal device is unchanged: voucher with orderIssueId is issued", async () => {
    const issueId = await openIssue();
    const before = await voucherRows();

    const response = await issueVoucher(
      { valueIdr: VALUE_IDR, reason: REASON, orderIssueId: issueId },
      { who: session },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await voucherRows()).toBe(before + 1);
  });

  it("a personal device is unchanged: standalone voucher is issued", async () => {
    const before = await voucherRows();

    const response = await issueVoucher(
      { valueIdr: VALUE_IDR, reason: REASON },
      { who: cashier },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await voucherRows()).toBe(before + 1);
  });
});
