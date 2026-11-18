// legend-1027 (brief 1027): a session that was EVER marked with a shared device
// stays shared-device forever. If the device is later unflagged or revoked and the
// session close fails (or has not run yet), the mark must NOT reopen owner access:
// back office and non-allowlisted /api/auth/* stay 403 ACTING_STAFF_NOT_ALLOWED,
// POS routes still demand a cashier token. Written from the card brief, not from
// the implementation.
//
// Assumptions:
//  - "Session close failed" is simulated by changing the device row directly in SQL
//    (unflag, or status 'revoked' + revoked_at). That never goes through the
//    service that closes sessions, so the session stays alive and marked, which is
//    exactly the failure state under test (no mock needed).
//  - "Sessions with lapsed marks still demand the PIN" = POS route answers 401
//    ACTING_STAFF_REQUIRED when no X-Acting-Staff header is sent.
//  - Keep-alive POST /api/auth/sessions/current/activity needs a management-kind
//    session (customer-kind gets the route's own 403), so the test sets that kind.
//  - Never-marked personal session = a fresh login of the same member type that
//    never touched any device; it stays 200 on back office and update-user.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededHostname,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const NOT_ALLOWED = "ACTING_STAFF_NOT_ALLOWED";
const REQUIRED = "ACTING_STAFF_REQUIRED";
const POS_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "shift.cash.operate",
  "floor.table.view",
  "floor.table.operate",
  "floor.table.manage",
  "kds.ticket.process",
  "kds.station.manage",
];

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string; sessionId: string };
type Res = { status: number; body: unknown };

let app: Express;
let tenant: IsolatedTenant;
let posRoleId: string;
const deviceIds: string[] = [];

const BACKOFFICE_ROUTES = [
  "/api/accounting/asset-categories",
  "/api/inventory/suppliers",
  "/api/hris/employees",
  "/api/org/brands",
  "/api/access/roles",
];

const LAPSES: Array<{ name: string; apply: (id: string) => Promise<unknown> }> =
  [
    {
      name: "device unflagged",
      apply: (id) =>
        owner.query("UPDATE devices SET shared_mode = false WHERE id = $1", [
          id,
        ]),
    },
    {
      name: "device revoked",
      apply: (id) =>
        owner.query(
          "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
          [id],
        ),
    },
  ];

const codeOf = (response: Res) =>
  (response.body as { error?: { code?: string } }).error?.code ?? "";

function expectNotAllowed(response: Res) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(NOT_ALLOWED);
}

async function newDevice(): Promise<string> {
  const id = randomUUID();
  deviceIds.push(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
    [id, tenant.tenantId, tenant.outletId, `Kasir 1027 ${id.slice(0, 6)}`],
  );
  return id;
}

async function member(label: string): Promise<Member> {
  const staff = await staffWithRole(app, { template: "owner", label });
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, staff.userId, posRoleId],
  );
  await verifySessionMfa(staff.email);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM "session" WHERE user_id = $1`,
    [staff.userId],
  );
  expect(rows).toHaveLength(1);
  return {
    client: staff.client,
    userId: staff.userId,
    sessionId: rows[0]!.id,
  };
}

/** A marked session whose device has already lapsed (session left open). */
async function lapsedMember(label: string, lapse: (typeof LAPSES)[number]) {
  const device = await newDevice();
  const who = await member(label);
  expect(await markSessionSharedDevice(who.sessionId, device)).toBe(true);
  // Sanity: while the device is active the back office is closed.
  expectNotAllowed(await backoffice(who, "/api/org/brands"));
  await lapse.apply(device);
  return { who, device };
}

async function expiresAt(sessionId: string): Promise<Date> {
  const { rows } = await owner.query<{ expires_at: Date }>(
    `SELECT expires_at FROM "session" WHERE id = $1`,
    [sessionId],
  );
  expect(rows).toHaveLength(1);
  return new Date(rows[0]!.expires_at);
}

const backoffice = (who: Member, path: string) =>
  who.client.get(path).set({ Host: seededHostname }).set(originHeader);

const authPost = (who: Member, path: string, body: object = {}) =>
  who.client.post(path).set(originHeader).send(body);

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`lp-${randomUUID().slice(0, 6)}`);
  posRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Lapuk 1027', false, NULL, $3, false, '["tenant"]')`,
    [posRoleId, tenant.tenantId, JSON.stringify(POS_PERMISSIONS)],
  );
  setDeviceOutletResolver(async ({ tenantId }) =>
    tenantId === tenant.tenantId ? tenant.outletId : null,
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("DELETE FROM pos_acting_staff WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    deviceIds,
  ]);
  await dropIsolatedTenant(tenant);
  await owner.end();
});

describe.each(LAPSES)(
  "1027 marked session after its mark lapsed ($name), session not closed",
  (lapse) => {
    it("a) every back-office router still answers 403 ACTING_STAFF_NOT_ALLOWED", async () => {
      const { who } = await lapsedMember("Sesi Lapuk Backoffice", lapse);
      for (const path of BACKOFFICE_ROUTES) {
        expectNotAllowed(await backoffice(who, path));
      }
    });

    it("b) non-allowlisted /api/auth/* paths still answer 403 ACTING_STAFF_NOT_ALLOWED", async () => {
      const { who } = await lapsedMember("Sesi Lapuk Auth", lapse);
      expectNotAllowed(
        await authPost(who, "/api/auth/update-user", { name: "X" }),
      );
      expectNotAllowed(
        await who.client.get("/api/auth/list-sessions").set(originHeader),
      );
      expectNotAllowed(await authPost(who, "/api/auth/revoke-other-sessions"));
    });

    it("c) a POS route without a cashier token still demands the PIN (401 ACTING_STAFF_REQUIRED)", async () => {
      const { who } = await lapsedMember("Sesi Lapuk POS", lapse);
      const response = await who.client
        .get(
          `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/parked-orders`,
        )
        .set({ Host: tenant.hostname })
        .set(originHeader);
      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expect(codeOf(response), JSON.stringify(response.body)).toBe(REQUIRED);
    });

    it("e) the keep-alive path (sessions/current/activity) still works for the marked session", async () => {
      const { who } = await lapsedMember("Sesi Lapuk KeepAlive", lapse);
      await owner.query(
        `UPDATE "session" SET kind = 'management', created_at = now() - interval '40 minutes',
           last_seen_at = now() - interval '28 minutes', expires_at = now() + interval '2 minutes'
         WHERE id = $1`,
        [who.sessionId],
      );
      const before = await expiresAt(who.sessionId);
      const response = await authPost(
        who,
        "/api/auth/sessions/current/activity",
      );
      expect([200, 204], JSON.stringify(response.body)).toContain(
        response.status,
      );
      // The keep-alive must actually extend the session, not just answer 200.
      expect((await expiresAt(who.sessionId)).getTime()).toBeGreaterThan(
        before.getTime(),
      );
      const session = await who.client
        .get("/api/auth/get-session")
        .set(originHeader);
      expect(session.status).toBe(200);
      expect(session.body?.user?.id).toBe(who.userId);
    });

    it("f) sign-out (allowlisted) still works and removes the session row", async () => {
      const { who } = await lapsedMember("Sesi Lapuk SignOut", lapse);
      const response = await authPost(who, "/api/auth/sign-out");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const { rows } = await owner.query(
        `SELECT 1 FROM "session" WHERE id = $1`,
        [who.sessionId],
      );
      expect(rows).toHaveLength(0);
    });
  },
);

describe("1027 device row gone", () => {
  // Assumption: the spec says a mark never lapses, so deleting the device row
  // entirely (if the schema allows it) must not reopen the back office either.
  it("g) a marked session whose device row was deleted still answers 403 ACTING_STAFF_NOT_ALLOWED", async () => {
    const device = await newDevice();
    const who = await member("Sesi Perangkat Hilang");
    expect(await markSessionSharedDevice(who.sessionId, device)).toBe(true);
    expectNotAllowed(await backoffice(who, "/api/org/brands"));
    await owner.query("DELETE FROM devices WHERE id = $1", [device]);
    expectNotAllowed(await backoffice(who, "/api/org/brands"));
    expectNotAllowed(
      await authPost(who, "/api/auth/update-user", { name: "X" }),
    );
  });
});

describe("1027 personal sessions stay open", () => {
  it("d) a never-marked session keeps back office and account changes open while another login's mark has lapsed", async () => {
    const lapsed = await lapsedMember("Sesi Lapuk Pembanding", LAPSES[0]!);
    expect(lapsed.who.sessionId).toBeTruthy();
    const personal = await member("Sesi Pribadi 1027");
    const brands = await backoffice(personal, "/api/org/brands");
    expect(brands.status, JSON.stringify(brands.body)).toBe(200);
    const update = await authPost(personal, "/api/auth/update-user", {
      name: "Pribadi Tetap Boleh",
    });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
  });
});
