// POS "Berhenti menunggu" (sub-brief E3, tier K access): the device's active
// cashier withdraws their own pending phone-approval override without the
// back-office MFA gate. PRD v1.7 §3 F6 "Override Supervisor", §3 F7,
// AUTH-06, TEN-01/02.
//
// Contract under test: POST /api/pos-overrides/approvals/:requestId/cancel
// (:requestId = the override's approvalRequestId)
//   - guards: signed-in session, trusted Origin, tenant from the domain, a
//     signed device token AND a live X-Acting-Staff token (the acting cashier
//     is the actor, never the session owner)
//   - only a request with sourceModule "pos_override" (opened by
//     POST /api/pos-overrides, method supervisor_phone), requested by the
//     acting cashier, in the device's tenant AND outlet
//   - pending -> 200 cancelled + one approval.resolved (outcome cancelled) +
//     audit row by the cashier, and the override ends with no override
//     (pos_overrides status "cancelled"); repeat -> 200, no second event
//   - another staff member / the session owner / another outlet / another
//     tenant / an inbox request -> 404 (no leak); approved or rejected -> 409
//   - no acting cashier -> 401 ACTING_STAFF_INVALID; token without the device
//     signature (or of another device) -> 401; no trusted Origin -> 403
// The refused cases must leave the request pending.
// Real Express app + Better Auth + PostgreSQL (disposable server).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const OTHER_PIN = "739151";
const [deviceA, deviceB, outletB] = [1, 2, 3].map(() => randomUUID()) as [
  string,
  string,
  string,
];
const tillRole = randomUUID();
const audits: AuditEntry[] = [];

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let otherTenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let staff: Member;
let otherStaff: Member;

const deviceToken = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function member(label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, tillRole],
  );
  return { client, userId };
}

async function tokenFor(
  deviceId: string,
  who: Member = staff,
  pin = PIN,
): Promise<string> {
  const response = await sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({ userId: who.userId, pin });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

type Opened = { overrideId: string; requestId: string };

/**
 * A phone-approval override as the POS opens it (supervisor_phone). With a
 * token the acting cashier is the requester; without one, the session owner.
 */
async function openPhoneOverride(
  options: { token?: string; deviceId?: string; outletId?: string } = {},
): Promise<Opened> {
  let request = sessionOwner.client
    .post("/api/pos-overrides")
    .set(headers)
    .set(originHeader)
    .set("Idempotency-Key", `posc-${randomUUID()}`)
    .set(DEVICE_TOKEN_HEADER, deviceToken(options.deviceId ?? deviceA));
  if (options.token) request = request.set(ACTING_HEADER, options.token);
  const response = await request.send({
    outletId: options.outletId ?? tenant.outletId,
    action: "void",
    valueIdr: 25000,
    reason: "Pelanggan batal pesan.",
    objectType: "order",
    objectId: randomUUID(),
    approval: { method: "supervisor_phone" },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const data = response.body.data as {
    id: string;
    approvalRequestId: string | null;
  };
  expect(data.approvalRequestId).not.toBeNull();
  return { overrideId: data.id, requestId: data.approvalRequestId as string };
}

/** A request seeded straight into approval_requests (cases POS cannot open). */
async function seedRequest(options: {
  tenantId: string;
  outletId: string;
  sourceModule: string;
  actionType?: string;
}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO approval_requests
       (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
        object_id, payload, requested_by, source, level, required_levels,
        required_steps, status, request_reason, deadline_at, created_at, updated_at)
     VALUES ($1, $2, $3, $1, $4, $5, 'order', $6, '{}', $7, 'user', 1, 1,
             '[]'::jsonb, 'pending', 'Pelanggan batal pesan.',
             now() + interval '1 hour', now() - interval '1 minute',
             now() - interval '1 minute')`,
    [
      id,
      options.tenantId,
      options.outletId,
      options.sourceModule,
      options.actionType ?? "void",
      randomUUID(),
      staff.userId,
    ],
  );
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE id = $1",
    [id],
  );
  return rows[0]?.status;
}

async function overrideStatusOf(requestId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM pos_overrides WHERE approval_request_id = $1",
    [requestId],
  );
  return rows[0]?.status;
}

async function resolvedEvents(chainId: string) {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT event->'payload' AS payload
     FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
       AND event->>'name' = 'approval.resolved' AND destination = 'cloud-sync'`,
    [tenant.tenantId, chainId],
  );
  return rows;
}

function cancel(
  requestId: string,
  options: {
    token?: string | null;
    deviceId?: string | null;
    origin?: boolean;
  } = {},
) {
  let request = sessionOwner.client
    .post(`/api/pos-overrides/approvals/${requestId}/cancel`)
    .set(headers);
  if (options.origin !== false) request = request.set(originHeader);
  const deviceId = options.deviceId === undefined ? deviceA : options.deviceId;
  if (deviceId !== null)
    request = request.set(DEVICE_TOKEN_HEADER, deviceToken(deviceId));
  if (options.token) request = request.set(ACTING_HEADER, options.token);
  return request.send({});
}

function read(
  requestId: string,
  options: { token?: string | null; deviceId?: string | null } = {},
) {
  let request = sessionOwner.client
    .get(`/api/pos-overrides/approvals/${requestId}`)
    .set(headers)
    .set(originHeader);
  const deviceId = options.deviceId === undefined ? deviceA : options.deviceId;
  if (deviceId !== null)
    request = request.set(DEVICE_TOKEN_HEADER, deviceToken(deviceId));
  if (options.token) request = request.set(ACTING_HEADER, options.token);
  return request;
}

beforeAll(async () => {
  app = createApp();
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
  const suffix = randomUUID().slice(0, 6);
  tenant = await createIsolatedTenant(`posc-${suffix}`);
  otherTenant = await createIsolatedTenant(`posc2-${suffix}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    if (tenantId !== tenant.tenantId) return null;
    if (deviceId === deviceA) return tenant.outletId;
    if (deviceId === deviceB) return outletB;
    return null;
  });
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Cancel Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      tillRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "shift.cash.operate",
        "pos.override.request",
      ]),
    ],
  );
  // A void always routes to the phone (threshold null): supervisor_phone opens.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'void', NULL, $2, 1)`,
    [tenant.tenantId, tillRole],
  );
  sessionOwner = await member("Sesi Login Batal");
  staff = await member("Kasir Pembatal");
  otherStaff = await member("Kasir Lain");
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Dua', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `PC2-${randomUUID().slice(0, 6)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const tenantCtx = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  for (const outletId of [tenant.outletId, outletB])
    await setStaffPin(
      tenantCtx,
      staff.userId,
      { outletId, userId: staff.userId },
      { pin: PIN },
    );
  await setStaffPin(
    tenantCtx,
    otherStaff.userId,
    { outletId: tenant.outletId, userId: otherStaff.userId },
    { pin: OTHER_PIN },
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $3, $4, 'pos', 'Kasir A', now() - interval '1 minute'),
              ($2, $3, $5, 'pos', 'Kasir B', now() - interval '1 minute')`,
      [deviceA, deviceB, tenant.tenantId, tenant.outletId, outletB],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  for (const row of [tenant, otherTenant])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      row.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("E3 POST /api/pos-overrides/approvals/:requestId/cancel", () => {
  it("E3 the acting cashier cancels their own pending phone override: 200 cancelled, one approval.resolved, audit by the cashier, no override", async () => {
    const token = await tokenFor(deviceA);
    const { overrideId, requestId } = await openPhoneOverride({ token });
    expect(await overrideStatusOf(requestId)).toBe("pending");

    const response = await cancel(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      id: requestId,
      status: "cancelled",
      requestedBy: staff.userId,
    });
    expect(await statusOf(requestId)).toBe("cancelled");
    const events = await resolvedEvents(requestId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.outcome).toBe("cancelled");
    expect(
      audits.some(
        (row) =>
          row.objectId === requestId &&
          row.action === "approval.cancelled" &&
          row.actorId === staff.userId,
      ),
    ).toBe(true);
    // The override side ends with no override, before any poll.
    expect(await overrideStatusOf(requestId)).toBe("cancelled");
    const polled = await sessionOwner.client
      .get(`/api/pos-overrides/${overrideId}`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken(deviceA))
      .set(ACTING_HEADER, token);
    expect(polled.status, JSON.stringify(polled.body)).toBe(200);
    expect(polled.body.data).toMatchObject({
      status: "cancelled",
      approvedBy: null,
    });

    const repeat = await cancel(requestId, { token });
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(repeat.body.data).toMatchObject({
      id: requestId,
      status: "cancelled",
    });
    expect(await resolvedEvents(requestId)).toHaveLength(1);
  });

  it("E3 the POS sends the cancel with no body and no content-type (as the browser does): 200 cancelled, not 415", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    const response = await sessionOwner.client
      .post(`/api/pos-overrides/approvals/${requestId}/cancel`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken(deviceA))
      .set(ACTING_HEADER, token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      id: requestId,
      status: "cancelled",
    });
    expect(await statusOf(requestId)).toBe("cancelled");
  });

  it("E3 a request past its deadline (sweep not run) is 409 and the override is not approved", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    await owner.query(
      `UPDATE approval_requests
       SET created_at = now() - interval '2 hours',
           deadline_at = now() - interval '1 minute'
       WHERE id = $1`,
      [requestId],
    );
    const response = await cancel(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await statusOf(requestId)).toBe("pending");
    expect(await overrideStatusOf(requestId)).not.toBe("approved");
    expect(await resolvedEvents(requestId)).toHaveLength(0);
  });

  it("E3 after a cancel there is no pos_override.recorded event and no override audit row", async () => {
    const token = await tokenFor(deviceA);
    const { overrideId, requestId } = await openPhoneOverride({ token });
    const response = await cancel(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await overrideStatusOf(requestId)).toBe("cancelled");
    const { rows } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'pos_override.recorded'
         AND event->'payload'->>'overrideId' = $2`,
      [tenant.tenantId, overrideId],
    );
    expect(rows).toHaveLength(0);
    expect(
      audits.filter(
        (row) =>
          row.objectId === overrideId && row.action === "pos_override.recorded",
      ),
    ).toHaveLength(0);
  });

  it("E3 the cancel audit row carries the signed device id", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    const response = await cancel(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const row = audits.find(
      (entry) =>
        entry.objectId === requestId && entry.action === "approval.cancelled",
    );
    expect(row?.deviceId).toBe(deviceA);
  });

  it("E3 a revoked cashier token is 401 and the request stays pending", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    await owner.query(
      `UPDATE pos_acting_staff SET revoked_at = now(), revoke_reason = 'ended'
       WHERE tenant_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL`,
      [tenant.tenantId, staff.userId],
    );
    const response = await cancel(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error.code).toBe("ACTING_STAFF_REVOKED");
    expect(await statusOf(requestId)).toBe("pending");
    expect(await overrideStatusOf(requestId)).toBe("pending");
  });

  it("E3 a cashier who is no longer a member of the outlet is refused and the request stays pending", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    await owner.query(
      `UPDATE role_assignments SET valid_until = now() - interval '1 minute'
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.tenantId, staff.userId],
    );
    try {
      const response = await cancel(requestId, { token });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe("ACTING_STAFF_INACTIVE");
      expect(await statusOf(requestId)).toBe("pending");
      expect(await overrideStatusOf(requestId)).toBe("pending");
    } finally {
      await owner.query(
        `UPDATE role_assignments SET valid_until = NULL
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenant.tenantId, staff.userId],
      );
    }
  });

  it("E3 a 2-level chain with level 1 approved is cancelled by the level-1 id: 200 and the override is cancelled", async () => {
    const token = await tokenFor(deviceA);
    const { requestId: level1 } = await openPhoneOverride({ token });
    await owner.query(
      `UPDATE approval_requests SET required_levels = 2, status = 'approved',
         decided_by = $2, decided_at = GREATEST(now(), created_at), reason = 'Level 1 setuju.' WHERE id = $1`,
      [level1, otherStaff.userId],
    );
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO approval_requests
         (tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
          requested_by, source, level, required_levels, required_steps, request_reason, deadline_at)
       SELECT tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
          requested_by, source, 2, required_levels, required_steps, request_reason,
          now() + interval '1 hour'
       FROM approval_requests WHERE id = $1
       RETURNING id`,
      [level1],
    );
    const level2 = rows[0]!.id;
    const response = await cancel(level1, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      id: level2,
      status: "cancelled",
    });
    expect(await statusOf(level2)).toBe("cancelled");
    expect(await statusOf(level1)).toBe("approved");
    expect(await overrideStatusOf(level1)).toBe("cancelled");
  });

  it("E3 another staff member's request is 404 and stays pending", async () => {
    const theirs = await openPhoneOverride({
      token: await tokenFor(deviceA, otherStaff, OTHER_PIN),
    });
    const token = await tokenFor(deviceA);
    const response = await cancel(theirs.requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(theirs.requestId)).toBe("pending");
    expect(await overrideStatusOf(theirs.requestId)).toBe("pending");
  });

  it("E3 the session owner's own request is not cancelled through the cashier token (404)", async () => {
    const owners = await openPhoneOverride();
    const token = await tokenFor(deviceA);
    const response = await cancel(owners.requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(owners.requestId)).toBe("pending");
  });

  it("E3 a request of another outlet than the device's is 404 and stays pending", async () => {
    const atB = await openPhoneOverride({
      token: await tokenFor(deviceB),
      deviceId: deviceB,
      outletId: outletB,
    });
    const token = await tokenFor(deviceA);
    const response = await cancel(atB.requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(atB.requestId)).toBe("pending");
  });

  it("E3 a token of device A sent with device B's signature is 401 and the request stays pending", async () => {
    const atB = await openPhoneOverride({
      token: await tokenFor(deviceB),
      deviceId: deviceB,
      outletId: outletB,
    });
    const token = await tokenFor(deviceA);
    const response = await cancel(atB.requestId, { token, deviceId: deviceB });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(await statusOf(atB.requestId)).toBe("pending");
  });

  it("E3 a request of another tenant (same requester id) is 404 and stays pending", async () => {
    const token = await tokenFor(deviceA);
    const id = await seedRequest({
      tenantId: otherTenant.tenantId,
      outletId: otherTenant.outletId,
      sourceModule: "pos_override",
    });
    const response = await cancel(id, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await statusOf(id)).toBe("pending");
  });

  it("E3 an inbox request (override action or not) is 404 and stays pending: the POS path only cancels pos_override", async () => {
    const token = await tokenFor(deviceA);
    const inboxVoid = await seedRequest({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      sourceModule: "inbox",
    });
    const inboxPurchase = await seedRequest({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      sourceModule: "inbox",
      actionType: "purchase_order",
    });
    for (const id of [inboxVoid, inboxPurchase]) {
      const response = await cancel(id, { token });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(await statusOf(id)).toBe("pending");
    }
  });

  it("E3 an approved or rejected request is 409 and the outcome stands", async () => {
    const token = await tokenFor(deviceA);
    for (const status of ["approved", "rejected"]) {
      const { requestId } = await openPhoneOverride({ token });
      await owner.query(
        `UPDATE approval_requests
           SET status = $2, decided_by = $3, decided_at = GREATEST(now(), created_at), reason = 'Diputus supervisor.'
         WHERE id = $1`,
        [requestId, status, otherStaff.userId],
      );
      const response = await cancel(requestId, { token });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await statusOf(requestId)).toBe(status);
    }
  });

  it("E3 without an acting cashier the cancel is 401 ACTING_STAFF_INVALID, even for the session owner's own request", async () => {
    const owners = await openPhoneOverride();
    const response = await cancel(owners.requestId, { token: null });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error?.code).toBe("ACTING_STAFF_INVALID");
    expect(await statusOf(owners.requestId)).toBe("pending");
  });

  it("E3 an acting-staff token without the device signature is 401 and the request stays pending", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    const response = await cancel(requestId, { token, deviceId: null });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(await statusOf(requestId)).toBe("pending");
  });

  it("E3 without a trusted Origin the cancel is 403 and the request stays pending", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    const response = await cancel(requestId, { token, origin: false });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await statusOf(requestId)).toBe("pending");
  });
});

describe("E3 GET /api/pos-overrides/approvals/:requestId (PhoneWait poll)", () => {
  it("E3 the acting cashier reads their own pending phone override request", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    const response = await read(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      id: requestId,
      status: "pending",
      requestedBy: staff.userId,
      actionType: "void",
    });
    expect(typeof response.body.data.deadlineAt).toBe("string");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("E3 a decided request is read with its outcome and reason", async () => {
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    await owner.query(
      `UPDATE approval_requests
         SET status = 'rejected', decided_by = $2, decided_at = GREATEST(now(), created_at), reason = 'Nilai tidak sesuai.'
       WHERE id = $1`,
      [requestId, otherStaff.userId],
    );
    const response = await read(requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "rejected",
      reason: "Nilai tidak sesuai.",
      decidedBy: otherStaff.userId,
    });
  });

  it("E3 another cashier's or the session owner's request is 404", async () => {
    const theirs = await openPhoneOverride({
      token: await tokenFor(deviceA, otherStaff, OTHER_PIN),
    });
    const owners = await openPhoneOverride();
    const token = await tokenFor(deviceA);
    for (const id of [theirs.requestId, owners.requestId]) {
      const response = await read(id, { token });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    }
  });

  it("E3 a request of another outlet than the device's is 404", async () => {
    const atB = await openPhoneOverride({
      token: await tokenFor(deviceB),
      deviceId: deviceB,
      outletId: outletB,
    });
    const token = await tokenFor(deviceA);
    const response = await read(atB.requestId, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  it("E3 a request of another tenant (same requester id) is 404", async () => {
    const token = await tokenFor(deviceA);
    const id = await seedRequest({
      tenantId: otherTenant.tenantId,
      outletId: otherTenant.outletId,
      sourceModule: "pos_override",
    });
    const response = await read(id, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  it("E3 an inbox request is 404 on the POS read", async () => {
    const token = await tokenFor(deviceA);
    const id = await seedRequest({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      sourceModule: "inbox",
    });
    const response = await read(id, { token });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  it("E3 without an acting cashier the read is 401 ACTING_STAFF_INVALID; without the device signature 401", async () => {
    const owners = await openPhoneOverride();
    const bare = await read(owners.requestId, { token: null });
    expect(bare.status, JSON.stringify(bare.body)).toBe(401);
    expect(bare.body.error?.code).toBe("ACTING_STAFF_INVALID");
    const token = await tokenFor(deviceA);
    const { requestId } = await openPhoneOverride({ token });
    const unsigned = await read(requestId, { token, deviceId: null });
    expect(unsigned.status, JSON.stringify(unsigned.body)).toBe(401);
  });
});
