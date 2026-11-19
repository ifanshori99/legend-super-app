// Acting staff wave 3, order recovery (briefs i0ipj / m05vx). Fail-first tests.
//
// Contract: POST /api/order-items/:id/issues (report) and
// POST /api/order-issues/:id/resolve honor the shared-tablet rule:
//  - flagged (shared) device + no X-Acting-Staff: 401 ACTING_STAFF_REQUIRED,
//    nothing is written (the guard runs before any recovery work).
//  - valid cashier token: the call passes and the cashier, not the session
//    owner, is the recorded actor.
//  - private (unflagged) device or a plain browser: unchanged, the session
//    owner stays the actor.
//  - another tenant's staff never reaches this tenant's items or issues.
//  - resolving again never doubles the refund (one outbox event).
//
// Assumptions:
//  - The brief names the code SHARED_DEVICE_REQUIRED; the shared contract
//    (ACTING_STAFF_ERROR_CODES.REQUIRED) names the shared-tablet refusal
//    ACTING_STAFF_REQUIRED, so that is asserted (status 401).
//  - Actor evidence = actor-ish columns of the order_issues row (reported_by),
//    audit_logs rows about the issue (event.actorId) and the actor.id of the
//    order_issue.resolved / manual_refund_approved outbox events (resolve
//    keeps no resolver column).
//    The no-header calibration test proves the helper sees the session owner.
//  - "Refund not doubled" = one `order_issue.manual_refund_approved` outbox
//    event and no payment_refunds row from the route itself (the worker is
//    not running in tests), also after a replay with a token.
//  - Session owner = a fresh outlet supervisor per test (the shared tablet
//    login); cashier = another outlet supervisor (distinct user, same
//    permission). Setup reports/resolves use the world's tenant supervisor.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { originHeader } from "./helpers.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner, staffWithRole, type Staff } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const REASON = "Pelanggan menolak ganti menu dan voucher";

let w: World;
/**
 * The shared-tablet login of the current test. A fresh user per test: a call
 * on a flagged device marks the login session for good, so reusing one session
 * would make later plain-browser or private-device tests fail.
 */
let session: Staff;
const devices = new Set<string>();

beforeAll(async () => {
  w = await createWorld();
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId && devices.has(deviceId)
      ? w.tenant.outletId
      : null,
  );
}, 120_000);

beforeEach(async () => {
  session = await w.newOutletSupervisor();
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await w.teardown();
});

type Response = { status: number; body: unknown };

async function newDevice(flagged: boolean): Promise<string> {
  const id = randomUUID();
  devices.add(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, w.tenant.tenantId, w.tenant.outletId, `Kasir Pulih ${id.slice(0, 6)}`],
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

/** The cashier signs in with a PIN on the device the owner session is using. */
async function cashierToken(deviceId: string): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    w.outletSupervisor.userId,
    { outletId: w.tenant.outletId, userId: w.outletSupervisor.userId },
    { pin: PIN },
  );
  const response = await session.client
    .post("/api/staff-pins/pos-session")
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: w.outletSupervisor.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** A POST as the shared-tablet session owner; `deviceId` null = plain browser. */
function post(
  path: string,
  body: Record<string, unknown>,
  deviceId: string | null,
  token?: string,
) {
  let request = session.client.post(path).set(w.headers).set(originHeader);
  if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceId));
  if (token) request = request.set(ACTING_HEADER, token);
  return request.send(body);
}

const reportBody = () => ({
  type: "unfulfillable",
  reason: "out_of_stock",
  reasonNote: "Roti habis di dapur",
});
const report = (
  itemId: string,
  deviceId: string | null,
  token?: string,
): Promise<Response> =>
  post(`/api/order-items/${itemId}/issues`, reportBody(), deviceId, token);
const resolveSwap = (
  issueId: string,
  deviceId: string | null,
  token?: string,
): Promise<Response> =>
  post(
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "swap", replacementItemId: w.ids.teh },
    deviceId,
    token,
  );

function expectError(response: Response, status: number, code: string) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

async function issueCount(itemId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM order_issues WHERE tenant_id = $1 AND order_item_id::text = $2",
    [w.tenant.tenantId, itemId],
  );
  return Number(rows[0]!.n);
}

async function issueStatus(issueId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issues WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]!.status;
}

/** Actor evidence of one issue (see Assumptions). */
async function actorEvidence(issueId: string): Promise<string> {
  const row = await owner.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(t) AS row FROM order_issues t WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, issueId],
  );
  const columns = Object.entries(row.rows[0]?.row ?? {})
    .filter(([key]) =>
      /(reported_by|resolved_by|created_by|updated_by|actor)/i.test(key),
    )
    .map(([, value]) => String(value));
  const audit = await owner.query<{ actor: string | null }>(
    `SELECT event->>'actorId' AS actor FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2`,
    [w.tenant.tenantId, issueId],
  );
  // Resolve keeps no resolver column: the actor is on the outbox event envelope.
  const events = [
    ...(await w.outboxRows("order_issue.resolved", issueId)),
    ...(await w.outboxRows("order_issue.manual_refund_approved", issueId)),
  ].map((row) =>
    row.event.actor.type === "user" ? row.event.actor.id : row.event.actor.type,
  );
  return [
    ...columns,
    ...audit.rows.map((r) => String(r.actor)),
    ...events,
  ].join("\n");
}

function expectCashier(evidence: string) {
  expect(evidence).toContain(w.outletSupervisor.userId);
  expect(evidence).not.toContain(session.userId);
}

async function refundEvents(issueId: string) {
  return w.outboxRows("order_issue.manual_refund_approved", issueId);
}

async function paymentRefundCount(issueId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_refunds WHERE tenant_id = $1 AND order_issue_id::text = $2",
    [w.tenant.tenantId, issueId],
  );
  return Number(rows[0]!.n);
}

async function approvedRefundBody(issueId: string) {
  const approvalRequestId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: 18_000,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  return {
    resolution: "manual_refund",
    approvalRequestId,
    reason: REASON,
  };
}

describe("acting staff on order recovery (wave 3)", () => {
  // Calibration: a plain browser keeps the session owner as the actor.
  it("no device, no header: report and resolve record the session owner", async () => {
    const { roti } = await w.paidOrder();
    const reported = await report(roti.id, null);
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const issueId = (reported.body as { data: { id: string } }).data.id;
    const resolved = await resolveSwap(issueId, null);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const evidence = await actorEvidence(issueId);
    expect(evidence).toContain(session.userId);
    expect(evidence).not.toContain(w.outletSupervisor.userId);
  });

  describe("report (POST /api/order-items/:id/issues)", () => {
    it("shared tablet without a PIN token: 401 ACTING_STAFF_REQUIRED, no issue is created", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      expectError(
        await report(roti.id, deviceId),
        401,
        "ACTING_STAFF_REQUIRED",
      );
      expect(await issueCount(roti.id)).toBe(0);
    });

    it("shared tablet with a cashier token: passes, the cashier is the reporter", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const token = await cashierToken(deviceId);
      const reported = await report(roti.id, deviceId, token);
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
      const issueId = (reported.body as { data: { id: string } }).data.id;
      expectCashier(await actorEvidence(issueId));
    });

    it("shared tablet with a garbage token: 401 ACTING_STAFF_INVALID, no issue is created", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      expectError(
        await report(roti.id, deviceId, "pas_garbage-token"),
        401,
        "ACTING_STAFF_INVALID",
      );
      expect(await issueCount(roti.id)).toBe(0);
    });

    it("private (unflagged) device without a token: works, the owner is the reporter", async () => {
      const deviceId = await newDevice(false);
      const { roti } = await w.paidOrder();
      const reported = await report(roti.id, deviceId);
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
      const issueId = (reported.body as { data: { id: string } }).data.id;
      const evidence = await actorEvidence(issueId);
      expect(evidence).toContain(session.userId);
      expect(evidence).not.toContain(w.outletSupervisor.userId);
    });

    it("another tenant's staff cannot report on this tenant's item", async () => {
      const { roti } = await w.paidOrder();
      const other = await staffWithRole(w.app, { template: "owner" });
      const response = await other.client
        .post(`/api/order-items/${roti.id}/issues`)
        .set(originHeader)
        .send(reportBody());
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await issueCount(roti.id)).toBe(0);
    });

    it("another tenant's session cannot use this tenant's cashier token", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const token = await cashierToken(deviceId);
      const other = await staffWithRole(w.app, { template: "owner" });
      const response = await other.client
        .post(`/api/order-items/${roti.id}/issues`)
        .set(originHeader)
        .set(ACTING_HEADER, token)
        .send(reportBody());
      expect([401, 403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await issueCount(roti.id)).toBe(0);
    });
  });

  describe("resolve (POST /api/order-issues/:id/resolve)", () => {
    it("shared tablet without a PIN token: 401 ACTING_STAFF_REQUIRED, the issue stays open", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      expectError(
        await resolveSwap(issueId, deviceId),
        401,
        "ACTING_STAFF_REQUIRED",
      );
      expect(await issueStatus(issueId)).toBe("open");
    });

    // CTO 19 Nov: swap and voucher are money out too, closed like manual refund.
    it("shared tablet with a cashier token: swap is refused 403 SHARED_DEVICE_SCREEN_CLOSED, the issue stays open", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const token = await cashierToken(deviceId);
      expectError(
        await resolveSwap(issueId, deviceId, token),
        403,
        "SHARED_DEVICE_SCREEN_CLOSED",
      );
      expect(await issueStatus(issueId)).toBe("open");
    });

    it("shared tablet with a cashier token: voucher is refused 403 SHARED_DEVICE_SCREEN_CLOSED, the issue stays open", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const token = await cashierToken(deviceId);
      expectError(
        await post(
          `/api/order-issues/${issueId}/resolve`,
          { resolution: "voucher", voucherId: randomUUID() },
          deviceId,
          token,
        ),
        403,
        "SHARED_DEVICE_SCREEN_CLOSED",
      );
      expect(await issueStatus(issueId)).toBe("open");
    });

    it("private (unflagged) device without a token: works, the owner is the resolver", async () => {
      const deviceId = await newDevice(false);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const resolved = await resolveSwap(issueId, deviceId);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      const evidence = await actorEvidence(issueId);
      expect(evidence).toContain(session.userId);
      expect(evidence).not.toContain(w.outletSupervisor.userId);
    });

    it("another tenant's staff cannot resolve this tenant's issue", async () => {
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const other = await staffWithRole(w.app, { template: "owner" });
      const response = await other.client
        .post(`/api/order-issues/${issueId}/resolve`)
        .set(originHeader)
        .send({ resolution: "swap", replacementItemId: w.ids.teh });
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await issueStatus(issueId)).toBe("open");
    });

    it("manual refund: an approval decided by the acting cashier is refused (approver is not the executor)", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const approvalRequestId = await w.insertApproval({
        actionType: "refund",
        objectType: "order_issue",
        objectId: issueId,
        amountIdr: 18_000,
        status: "approved",
        requestedBy: w.floorStaff.userId,
        decidedBy: w.outletSupervisor.userId,
      });
      const token = await cashierToken(deviceId);
      const response = await post(
        `/api/order-issues/${issueId}/resolve`,
        { resolution: "manual_refund", approvalRequestId, reason: REASON },
        deviceId,
        token,
      );
      // Assumption: the service rejects with 422 (unprocessable); any 4xx
      // is accepted as long as nothing is refunded.
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await issueStatus(issueId)).toBe("open");
      expect(await refundEvents(issueId)).toHaveLength(0);
      expect(await paymentRefundCount(issueId)).toBe(0);
    });

    // legend-iq0jz round 3: manual refund closed on shared tablet, founder decision pending.
    it("manual refund on a shared tablet: tablet login owner approving does not unlock it (401 without token, 403 SHARED_DEVICE_SCREEN_CLOSED with the cashier token)", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const approvalRequestId = await w.insertApproval({
        actionType: "refund",
        objectType: "order_issue",
        objectId: issueId,
        amountIdr: 18_000,
        status: "approved",
        requestedBy: w.floorStaff.userId,
        decidedBy: session.userId,
      });
      const path = `/api/order-issues/${issueId}/resolve`;
      const body = {
        resolution: "manual_refund",
        approvalRequestId,
        reason: REASON,
      };
      expectError(
        await post(path, body, deviceId),
        401,
        "ACTING_STAFF_REQUIRED",
      );
      const token = await cashierToken(deviceId);
      expectError(
        await post(path, body, deviceId, token),
        403,
        "SHARED_DEVICE_SCREEN_CLOSED",
      );
      expect(await issueStatus(issueId)).toBe("open");
      expect(await refundEvents(issueId)).toHaveLength(0);
      expect(await paymentRefundCount(issueId)).toBe(0);
    });

    // legend-iq0jz round 3: manual refund closed on shared tablet, founder decision pending.
    it("manual refund on a shared tablet: refused without a token (401) and with a token (403 SHARED_DEVICE_SCREEN_CLOSED), repeated calls never queue a refund", async () => {
      const deviceId = await newDevice(true);
      const { roti } = await w.paidOrder();
      const issueId = (await w.report(roti.id)).body.data.id as string;
      const body = await approvedRefundBody(issueId);
      const path = `/api/order-issues/${issueId}/resolve`;

      expectError(
        await post(path, body, deviceId),
        401,
        "ACTING_STAFF_REQUIRED",
      );
      expect(await refundEvents(issueId)).toHaveLength(0);
      expect(await issueStatus(issueId)).toBe("open");

      const token = await cashierToken(deviceId);
      for (let i = 0; i < 2; i += 1) {
        expectError(
          await post(path, body, deviceId, token),
          403,
          "SHARED_DEVICE_SCREEN_CLOSED",
        );
        expect(await refundEvents(issueId)).toHaveLength(0);
        expect(await issueStatus(issueId)).toBe("open");
      }
      expect(await paymentRefundCount(issueId)).toBe(0);

      // And again without any token: still refused, still no refund.
      expectError(
        await post(path, body, deviceId),
        401,
        "ACTING_STAFF_REQUIRED",
      );
      expect(await refundEvents(issueId)).toHaveLength(0);
    });
  });
});
