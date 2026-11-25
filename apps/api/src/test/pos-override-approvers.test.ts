// GET /api/pos-overrides/approvers?outletId&action (card 1268 B3). The POS
// supervisor-PIN dialog lists who can approve one override action in one outlet.
// Rules under test: the list is server-filtered by the action's approve
// permission (POS_OVERRIDE_APPROVE_PERMISSION) and a usable staff PIN at that
// outlet, never contains the requester, and is never opened to a caller
// without a valid staff session (shared device without acting-staff token,
// anonymous, or a user outside the outlet). Only `userId` and `displayName`
// leave the server.
// Real Express app + Better Auth + PostgreSQL (disposable server from
// `pnpm test`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { agent } from "./helpers.ts";
import {
  owner,
  seededHostname,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const PIN = "582914";
const tenantContext = establishTenantContext({
  tenantId: tenantIdSchema.parse(seededTenantId),
  brandId: null,
  source: "session",
});

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdDeviceIds: string[] = [];

let app: Express;
let cashier: Staff; // requester, no approve permission
let supervisor: Staff; // approve permissions + PIN at bandung
let requesterSupervisor: Staff; // a supervisor with PIN who asks
let voidOnly: Staff; // only pos.void.approve + PIN
let noPin: Staff; // supervisor without a PIN
let lockedPin: Staff; // supervisor whose PIN is locked
let cashierWithPin: Staff; // PIN but no approve permission
let otherOutletSupervisor: Staff; // supervisor + PIN at bandung2 only
let otherOutletCashier: Staff; // not a member of bandung

async function givePin(who: Staff, outletId = bandung) {
  await setStaffPin(
    tenantContext,
    who.userId,
    { outletId, userId: who.userId },
    { pin: PIN },
  );
}

async function member(
  label: string,
  template: "supervisor" | "cashier",
  outletId = bandung,
): Promise<Staff> {
  const who = await staffWithRole(app, {
    template,
    scopeType: "outlet",
    scopeId: outletId,
    label,
  });
  createdUserIds.push(who.userId);
  return who;
}

const approversOf = (
  who: { client: ReturnType<typeof agent> },
  query: string,
) =>
  who.client
    .get(`/api/pos-overrides/approvers?${query}`)
    .set("Host", seededHostname);

const q = (action: string, outletId = bandung) =>
  `outletId=${outletId}&action=${action}`;

const idsOf = (body: { data: { userId: string }[] }) =>
  body.data.map((entry) => entry.userId);

beforeAll(async () => {
  app = createApp();
  cashier = await member("B3 Kasir Peminta", "cashier");
  supervisor = await member("B3 Supervisor Sah", "supervisor");
  requesterSupervisor = await member("B3 Supervisor Peminta", "supervisor");
  noPin = await member("B3 Supervisor Tanpa PIN", "supervisor");
  lockedPin = await member("B3 Supervisor PIN Terkunci", "supervisor");
  cashierWithPin = await member("B3 Kasir Ber-PIN", "cashier");
  otherOutletSupervisor = await member(
    "B3 Supervisor Outlet Lain",
    "supervisor",
    bandung2,
  );
  otherOutletCashier = await member(
    "B3 Kasir Outlet Lain",
    "cashier",
    bandung2,
  );

  // A role that holds only the void approval, assigned at the outlet.
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'B3 Hanya Void', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, seededTenantId, JSON.stringify(["pos.void.approve"])],
  );
  voidOnly = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: bandung,
    label: "B3 Hanya Void",
  });
  createdUserIds.push(voidOnly.userId);
  await owner.query(
    `UPDATE role_assignments SET role_id = $3 WHERE tenant_id = $1 AND user_id = $2`,
    [seededTenantId, voidOnly.userId, roleId],
  );

  for (const who of [
    supervisor,
    requesterSupervisor,
    lockedPin,
    cashierWithPin,
    voidOnly,
  ])
    await givePin(who);
  await givePin(otherOutletSupervisor, bandung2);
  await owner.query(
    `UPDATE staff_pins SET locked_until = now() + interval '1 hour'
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
    [seededTenantId, bandung, lockedPin.userId],
  );
});

afterAll(async () => {
  if (createdDeviceIds.length > 0)
    await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
      createdDeviceIds,
    ]);
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [seededTenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, createdUserIds],
  );
  await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
    createdRoleIds,
  ]);
  await owner.end();
});

describe("card 1268 B3 GET /api/pos-overrides/approvers", () => {
  it("lists only staff with the action's approve permission and a usable PIN at the outlet", async () => {
    const response = await approversOf(cashier, q("discount"));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const ids = idsOf(response.body);
    expect(ids).toContain(supervisor.userId);
    expect(ids).toContain(requesterSupervisor.userId);
    expect(ids).not.toContain(noPin.userId);
    expect(ids).not.toContain(lockedPin.userId);
    expect(ids).not.toContain(cashierWithPin.userId);
    expect(ids).not.toContain(voidOnly.userId);
    expect(ids).not.toContain(otherOutletSupervisor.userId);
    expect(ids).not.toContain(cashier.userId);
  });

  it("filters by the action: a void-only approver is listed for void and not for discount", async () => {
    const forVoid = await approversOf(cashier, q("void"));
    expect(forVoid.status).toBe(200);
    expect(idsOf(forVoid.body)).toContain(voidOnly.userId);
    expect(idsOf(forVoid.body)).toContain(supervisor.userId);
    const forClose = await approversOf(cashier, q("cash_shift_close"));
    expect(forClose.status).toBe(200);
    expect(idsOf(forClose.body)).not.toContain(voidOnly.userId);
    expect(idsOf(forClose.body)).toContain(supervisor.userId);
  });

  it("never lists the requester, even when the requester holds the approval", async () => {
    const response = await approversOf(requesterSupervisor, q("void"));
    expect(response.status).toBe(200);
    const ids = idsOf(response.body);
    expect(ids).not.toContain(requesterSupervisor.userId);
    expect(ids).toContain(supervisor.userId);
  });

  it("returns only userId and displayName", async () => {
    const response = await approversOf(cashier, q("void"));
    const entry = (response.body.data as Record<string, unknown>[]).find(
      (row) => row.userId === supervisor.userId,
    );
    expect(entry).toEqual({
      userId: supervisor.userId,
      displayName: "B3 Supervisor Sah",
    });
    expect(response.headers["cache-control"]).toMatch(/no-store/);
  });

  it("refuses an anonymous caller", async () => {
    const response = await agent(app)
      .get(`/api/pos-overrides/approvers?${q("void")}`)
      .set("Host", seededHostname);
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain("Supervisor");
  });

  it("refuses a signed-in user who is not a member of the outlet", async () => {
    const response = await approversOf(otherOutletCashier, q("void"));
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("Supervisor");
  });

  it("refuses a shared device without an acting-staff session", async () => {
    const deviceId = randomUUID();
    createdDeviceIds.push(deviceId);
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
      [deviceId, seededTenantId, bandung, `Tablet B3 ${deviceId.slice(0, 6)}`],
    );
    const token = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: seededTenantId,
      brandId: null,
      deviceId,
    });
    // The refusal marks this session as used on a shared device for good, so
    // it gets its own cashier.
    const sharedCashier = await member("B3 Kasir Tablet Bersama", "cashier");
    const response = await sharedCashier.client
      .get(`/api/pos-overrides/approvers?${q("void")}`)
      .set(DEVICE_TOKEN_HEADER, token);
    expect(response.status).toBe(401);
    expect(response.body.error?.code ?? response.body.code).toBe(
      ACTING_STAFF_ERROR_CODES.REQUIRED,
    );
    expect(JSON.stringify(response.body)).not.toContain("Supervisor");
  });

  it("rejects an unknown action, a missing outlet and extra query keys", async () => {
    expect((await approversOf(cashier, q("teleport"))).status).toBe(422);
    expect((await approversOf(cashier, "action=void")).status).toBe(422);
    expect(
      (await approversOf(cashier, `${q("void")}&userId=${cashier.userId}`))
        .status,
    ).toBe(422);
  });
});
