// Open bill step 2 (legend-8cm4 convert endpoint, legend-2zb5 policy endpoints;
// founder Q33/Q34 = A; brief docs/briefs/sub-open-bill-step2.md).
//
// Real Express app + Better Auth + RBAC + PostgreSQL (disposable server from
// `pnpm test`). Written from the brief, not from the route code.
//
// Assumptions where the brief is silent:
// - The approvers list is readable by any holder of `floor.table.operate`
//   (the cashier who asks for the conversion needs it to fill the select).
// - Body validation errors answer 422 VALIDATION_ERROR (project convention in
//   the error handler), not 400.
// - A caller of another tenant gets 404 on the convert route (RLS hides the
//   session), as the brief states.
// - Audit fields are asserted loosely (substring of the stored event) because
//   the brief names the content but not the JSON layout; `actorId` is exact.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app.ts";
import { hashStaffPin } from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const PIN = "482913";
const WRONG_PIN = "135790";
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

let app: Express;
let outletId: string; // outlet that owns the zones the owner creates
let otherOutletId: string;
let manager: Staff; // owner (tenant scope): builds zones, tables, QR codes
const zoneIds: string[] = [];
const tableIds: string[] = [];
const pinUsers: string[] = [];

/** Real staff PIN row (HMAC pepper + scrypt bound to tenant/outlet/user). */
async function seedPin(
  tenantId: string,
  outlet: string,
  userId: string,
  pin = PIN,
) {
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(tenantId, outlet),
    binding: { tenantId, outletId: outlet, userId },
    pin,
  });
  const setAt = new Date(Date.now() - 60_000);
  await owner.query(
    `INSERT INTO staff_pins (id, tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
        pepper_version, failed_attempts, locked_until, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, NULL, $4, $11, $11, $11, $11)`,
    [
      randomUUID(),
      tenantId,
      outlet,
      userId,
      hashed.pinHash,
      hashed.salt,
      hashed.params.N,
      hashed.params.r,
      hashed.params.p,
      currentStaffPinPepperVersion(),
      setAt,
    ],
  );
  pinUsers.push(userId);
}

async function failedAttempts(userId: string, outlet = outletId) {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    `SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
    [seededTenantId, outlet, userId],
  );
  return rows[0]!.failed_attempts;
}

async function outletStaff(
  template: "supervisor" | "cashier" | "outlet_manager" | "waiter",
  label: string,
  outlet = outletId,
) {
  return staffWithRole(app, {
    template,
    scopeType: "outlet",
    scopeId: outlet,
    label,
  });
}

type Seated = { sessionId: string; token: string; zoneId: string };

/** A zone, a table and a guest session scanned on the seeded tenant host. */
async function seatSeeded(
  paymentMode: "pay_first" | "open_bill",
): Promise<Seated> {
  const zone = await createZone(manager.client, {
    paymentMode,
    hours: ALL_DAY,
  });
  zoneIds.push(zone.id);
  const table = await createTable(manager.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(manager.client, table.id);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  return {
    sessionId: scanned.body.data.session.id,
    token: scanned.body.data.sessionToken,
    zoneId: zone.id,
  };
}

type ConvertBody = Record<string, unknown>;

function convert(
  who: Staff,
  sessionId: string,
  body: ConvertBody,
  host = seededHostname,
) {
  return who.client
    .post(`/api/table-sessions/${sessionId}/open-bill`)
    .set(originHeader)
    .set("Host", host)
    .send(body);
}

const validBody = (approver: Staff, overrides: ConvertBody = {}) => ({
  reason: "Tamu minta bayar di akhir",
  approverUserId: approver.userId,
  pin: PIN,
  ...overrides,
});

async function sessionRow(sessionId: string) {
  const { rows } = await owner.query<{ payment_mode: string; status: string }>(
    `SELECT payment_mode, status FROM table_sessions WHERE tenant_id = $1 AND id = $2`,
    [seededTenantId, sessionId],
  );
  return rows[0]!;
}

async function convertAudits(tenantId: string, sessionId: string) {
  const { rows } = await owner.query<{
    event: Record<string, unknown> & { actorId?: string };
  }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'open_bill.session_converted' AND event->>'objectId' = $2`,
    [tenantId, sessionId],
  );
  return rows.map((row) => row.event);
}

const policyPath = (outlet: string) =>
  `/api/outlets/${outlet}/open-bill-policy`;
const getPolicy = (who: Staff, outlet = outletId, host = seededHostname) =>
  who.client.get(policyPath(outlet)).set("Host", host);
const putPolicy = (
  who: Staff,
  body: Record<string, unknown>,
  outlet = outletId,
  host = seededHostname,
) =>
  who.client
    .put(policyPath(outlet))
    .set(originHeader)
    .set("Host", host)
    .send(body);
const approversOf = (who: Staff, outlet = outletId, host = seededHostname) =>
  who.client
    .get(`/api/outlets/${outlet}/open-bill/approvers`)
    .set("Host", host);

const validPolicy = {
  maxBillValueIdr: 500_000,
  inactivityMinutes: 30,
  billRequestSloSeconds: 90,
};

let supervisor: Staff; // approver with a PIN
let cashier: Staff; // requester
let cashierWithPin: Staff; // holds a PIN but not the approve permission
let outsideCashier: Staff; // cashier of the other outlet
let outsideSupervisor: Staff; // supervisor + PIN of the other outlet only
let outletManager: Staff;
let policyCashier: Staff;
let other: IsolatedTenant;
let otherStaff: Staff;

beforeAll(async () => {
  app = createApp();
  manager = await staffWithRole(app, { template: "owner", label: "OB Owner" });
  const probe = await createZone(manager.client, { hours: ALL_DAY });
  zoneIds.push(probe.id);
  outletId = probe.outletId as string;
  otherOutletId = [seededOutletA, seededOutletB].find((id) => id !== outletId)!;

  supervisor = await outletStaff("supervisor", "OB Supervisor Mm");
  cashier = await outletStaff("cashier", "OB Cashier");
  cashierWithPin = await outletStaff("cashier", "OB Cashier Pin");
  outsideCashier = await outletStaff(
    "cashier",
    "OB Cashier Out",
    otherOutletId,
  );
  outsideSupervisor = await outletStaff(
    "supervisor",
    "OB Supervisor Out",
    otherOutletId,
  );
  outletManager = await outletStaff("outlet_manager", "OB Outlet Manager");
  policyCashier = await outletStaff("cashier", "OB Cashier Policy");
  await seedPin(seededTenantId, outletId, supervisor.userId);
  await seedPin(seededTenantId, outletId, cashierWithPin.userId);
  await seedPin(seededTenantId, otherOutletId, outsideSupervisor.userId);

  other = await createIsolatedTenant(`obc-${randomUUID().slice(0, 6)}`);
  otherStaff = await staffOfIsolatedTenant(app, other);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM outlet_open_bill_policies WHERE tenant_id = $1 AND outlet_id = ANY($2)",
    [seededTenantId, [seededOutletA, seededOutletB]],
  );
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2)",
    [seededTenantId, pinUsers],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    other.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-8cm4 convert a pay-first session to open bill", () => {
  it("cashier asks, supervisor PIN approves: 200, session is open_bill, audited without the PIN", async () => {
    const seated = await seatSeeded("pay_first");
    const response = await convert(
      cashier,
      seated.sessionId,
      validBody(supervisor),
    );
    expect(response.status).toBe(200);
    expect(response.body.data.paymentMode).toBe("open_bill");
    expect(response.body.data.status).not.toBe("closed");
    expect(await sessionRow(seated.sessionId)).toMatchObject({
      payment_mode: "open_bill",
    });

    const audits = await convertAudits(seededTenantId, seated.sessionId);
    expect(audits).toHaveLength(1);
    const text = JSON.stringify(audits[0]);
    // Actor is the approver; requester, reason and both modes are recorded.
    expect(audits[0]!.actorId).toBe(supervisor.userId);
    expect(text).toContain(cashier.userId);
    expect(text).toContain("Tamu minta bayar di akhir");
    expect(text).toContain("pay_first");
    expect(text).toContain("open_bill");
    expect(text).not.toContain(PIN);
    expect(text).not.toMatch(/"pin"/i);
  });

  it("a supervisor may approve their own request (step-up)", async () => {
    const seated = await seatSeeded("pay_first");
    const response = await convert(
      supervisor,
      seated.sessionId,
      validBody(supervisor),
    );
    expect(response.status).toBe(200);
    expect(response.body.data.paymentMode).toBe("open_bill");
  });

  it("an approver who is a cashier gets 403 OPEN_BILL_APPROVER_DENIED and the PIN attempt is not counted", async () => {
    const seated = await seatSeeded("pay_first");
    const before = await failedAttempts(cashierWithPin.userId);
    // Wrong PIN on purpose: permission is checked before the PIN is touched.
    const response = await convert(
      cashier,
      seated.sessionId,
      validBody(cashierWithPin, { pin: WRONG_PIN }),
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("OPEN_BILL_APPROVER_DENIED");
    expect(await failedAttempts(cashierWithPin.userId)).toBe(before);
    expect((await sessionRow(seated.sessionId)).payment_mode).toBe("pay_first");
  });

  it("an approver who is supervisor of another outlet only is denied too", async () => {
    const seated = await seatSeeded("pay_first");
    const response = await convert(
      cashier,
      seated.sessionId,
      validBody(outsideSupervisor),
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("OPEN_BILL_APPROVER_DENIED");
    expect((await sessionRow(seated.sessionId)).payment_mode).toBe("pay_first");
  });

  it("a wrong PIN is refused, counted, and the session stays pay-first", async () => {
    const approver = await outletStaff("supervisor", "OB Supervisor Wrong");
    await seedPin(seededTenantId, outletId, approver.userId);
    const seated = await seatSeeded("pay_first");
    const response = await convert(
      cashier,
      seated.sessionId,
      validBody(approver, { pin: WRONG_PIN }),
    );
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("PIN_INVALID");
    expect(await failedAttempts(approver.userId)).toBe(1);
    expect((await sessionRow(seated.sessionId)).payment_mode).toBe("pay_first");
    expect(await convertAudits(seededTenantId, seated.sessionId)).toHaveLength(
      0,
    );
  });

  it("repeated wrong PINs lock the approver: even the right PIN is refused", async () => {
    const approver = await outletStaff("supervisor", "OB Supervisor Lock");
    await seedPin(seededTenantId, outletId, approver.userId);
    const seated = await seatSeeded("pay_first");
    for (let attempt = 0; attempt < 5; attempt += 1)
      await convert(
        cashier,
        seated.sessionId,
        validBody(approver, { pin: WRONG_PIN }),
      );
    const locked = await convert(
      cashier,
      seated.sessionId,
      validBody(approver),
    );
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("PIN_LOCKED");
    expect((await sessionRow(seated.sessionId)).payment_mode).toBe("pay_first");
  });

  it("refuses a session that is already open_bill, still pending confirmation, or closed with 409 OPEN_BILL_NOT_ELIGIBLE", async () => {
    // Pending confirmation: an open-bill zone session nobody confirmed yet.
    const pending = await seatSeeded("open_bill");
    expect((await sessionRow(pending.sessionId)).status).toBe(
      "pending_confirmation",
    );
    const pendingResponse = await convert(
      cashier,
      pending.sessionId,
      validBody(supervisor),
    );
    expect(pendingResponse.status).toBe(409);
    expect(pendingResponse.body.error.code).toBe("OPEN_BILL_NOT_ELIGIBLE");

    // Already open_bill: confirmed by staff, then asked to convert again.
    const confirmed = await manager.client
      .post(`/api/table-sessions/${pending.sessionId}/confirm`)
      .set("Host", seededHostname)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
    const again = await convert(
      cashier,
      pending.sessionId,
      validBody(supervisor),
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("OPEN_BILL_NOT_ELIGIBLE");

    // Converted once, then converted again.
    const once = await seatSeeded("pay_first");
    expect(
      (await convert(cashier, once.sessionId, validBody(supervisor))).status,
    ).toBe(200);
    const twice = await convert(cashier, once.sessionId, validBody(supervisor));
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("OPEN_BILL_NOT_ELIGIBLE");
    expect(await convertAudits(seededTenantId, once.sessionId)).toHaveLength(1);

    // Closed.
    const closed = await seatSeeded("pay_first");
    await owner.query(
      `UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_reason = 'paid_and_cleaned'
        WHERE tenant_id = $1 AND id = $2`,
      [seededTenantId, closed.sessionId],
    );
    const closedResponse = await convert(
      cashier,
      closed.sessionId,
      validBody(supervisor),
    );
    expect(closedResponse.status).toBe(409);
    expect(closedResponse.body.error.code).toBe("OPEN_BILL_NOT_ELIGIBLE");
    expect((await sessionRow(closed.sessionId)).payment_mode).toBe("pay_first");
  });

  it("rejects a reason that is too short or missing, and unknown fields, with 422", async () => {
    const seated = await seatSeeded("pay_first");
    for (const body of [
      validBody(supervisor, { reason: "ab" }),
      validBody(supervisor, { reason: "   " }),
      validBody(supervisor, { reason: "x".repeat(301) }),
      validBody(supervisor, { reason: undefined }),
      validBody(supervisor, { pin: "12345" }),
      validBody(supervisor, { approverUserId: "bukan-uuid" }),
      validBody(supervisor, { extra: true }),
    ]) {
      const response = await convert(cashier, seated.sessionId, body);
      expect(response.status).toBe(422);
    }
    expect((await sessionRow(seated.sessionId)).payment_mode).toBe("pay_first");
  });

  it("denies staff of another outlet (403), anonymous callers (401) and another tenant (404)", async () => {
    const seated = await seatSeeded("pay_first");
    const outside = await convert(
      outsideCashier,
      seated.sessionId,
      validBody(supervisor),
    );
    expect(outside.status).toBe(403);

    const anonymous = await agent(app)
      .post(`/api/table-sessions/${seated.sessionId}/open-bill`)
      .set(originHeader)
      .set("Host", seededHostname)
      .send(validBody(supervisor));
    expect(anonymous.status).toBe(401);

    const crossTenant = await convert(
      otherStaff,
      seated.sessionId,
      validBody(supervisor),
      other.hostname,
    );
    expect(crossTenant.status).toBe(404);
    expect((await sessionRow(seated.sessionId)).payment_mode).toBe("pay_first");
  });
});

describe("legend-8cm4 approvers list", () => {
  it("lists only staff holding the approve permission and an active PIN at the outlet, sorted by name", async () => {
    const early = await outletStaff("outlet_manager", "AAA OB Approver First");
    await seedPin(seededTenantId, outletId, early.userId);
    const noPin = await outletStaff("supervisor", "OB Supervisor No Pin");
    const response = await approversOf(cashier);
    expect(response.status).toBe(200);
    const list = response.body.data as {
      userId: string;
      displayName: string;
    }[];
    const ids = list.map((entry) => entry.userId);
    expect(ids).toContain(supervisor.userId);
    expect(ids).toContain(early.userId);
    // No permission (cashier with PIN), no PIN (supervisor), wrong outlet.
    expect(ids).not.toContain(cashierWithPin.userId);
    expect(ids).not.toContain(noPin.userId);
    expect(ids).not.toContain(outsideSupervisor.userId);
    expect(ids).not.toContain(cashier.userId);
    for (const entry of list) {
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(Object.keys(entry).sort()).toEqual(["displayName", "userId"]);
    }
    const names = list.map((entry) => entry.displayName);
    expect(names).toEqual(
      [...names].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
    );
    expect(ids.indexOf(early.userId)).toBeLessThan(
      ids.indexOf(supervisor.userId),
    );
  });

  it("the other outlet lists its own supervisor, not this outlet's", async () => {
    const response = await approversOf(outsideCashier, otherOutletId);
    expect(response.status).toBe(200);
    const ids = (response.body.data as { userId: string }[]).map(
      (entry) => entry.userId,
    );
    expect(ids).toContain(outsideSupervisor.userId);
    expect(ids).not.toContain(supervisor.userId);
  });

  it("is empty (200, data []) for an outlet where nobody has a PIN, and denied across outlets and anonymously", async () => {
    const empty = await approversOf(otherStaff, other.outletId, other.hostname);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    expect((await approversOf(outsideCashier, outletId)).status).toBe(403);
    const anonymous = await agent(app)
      .get(`/api/outlets/${outletId}/open-bill/approvers`)
      .set("Host", seededHostname);
    expect(anonymous.status).toBe(401);
  });
});

describe("legend-2zb5 open-bill policy endpoints", () => {
  it("an outlet manager saves the policy (200) and a read returns it", async () => {
    const saved = await putPolicy(outletManager, validPolicy);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ ...validPolicy, isDefault: false });
    const read = await getPolicy(outletManager);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ ...validPolicy, isDefault: false });
  });

  it("supervisor and cashier cannot change the policy (403) and nothing is stored", async () => {
    const before = (await getPolicy(outletManager)).body.data;
    const attempt = { ...validPolicy, maxBillValueIdr: 777_000 };
    expect((await putPolicy(supervisor, attempt)).status).toBe(403);
    expect((await putPolicy(cashier, attempt)).status).toBe(403);
    expect((await getPolicy(outletManager)).body.data).toEqual(before);
  });

  it("a cashier (floor.table.operate) can read the policy, with the defaults when none is stored", async () => {
    await owner.query(
      "DELETE FROM outlet_open_bill_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, outletId],
    );
    const read = await getPolicy(policyCashier);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      isDefault: true,
      maxBillValueIdr: 3_000_000,
      inactivityMinutes: 45,
      billRequestSloSeconds: 180,
    });
  });

  it("staff of another outlet is denied read (403) and write (403); anonymous is 401", async () => {
    expect((await getPolicy(outsideCashier, outletId)).status).toBe(403);
    expect(
      (await putPolicy(outsideCashier, validPolicy, outletId)).status,
    ).toBe(403);
    const anonymous = await agent(app)
      .get(policyPath(outletId))
      .set("Host", seededHostname);
    expect(anonymous.status).toBe(401);
  });

  it("rejects values outside the allowed ranges and unknown fields with 422", async () => {
    for (const body of [
      { ...validPolicy, maxBillValueIdr: 99_999 },
      { ...validPolicy, maxBillValueIdr: 1_000_000_001 },
      { ...validPolicy, inactivityMinutes: 4 },
      { ...validPolicy, billRequestSloSeconds: 29 },
      { ...validPolicy, billRequestSloSeconds: 3601 },
      { ...validPolicy, maxBillValueIdr: undefined },
      { ...validPolicy, isDefault: false },
    ]) {
      expect((await putPolicy(outletManager, body)).status).toBe(422);
    }
  });

  it("another tenant cannot read or write this outlet's policy", async () => {
    const read = await getPolicy(otherStaff, outletId, other.hostname);
    expect([403, 404]).toContain(read.status);
    const write = await putPolicy(
      otherStaff,
      validPolicy,
      outletId,
      other.hostname,
    );
    expect([403, 404]).toContain(write.status);
  });
});

// Exposure needs real orders, so this block uses an isolated tenant with a
// seeded menu. Its only staff member holds a custom role with the two new
// permissions, asks for the conversion and approves it (step-up).
describe("legend-8cm4 convert is refused at the outlet limit", () => {
  let tenant: IsolatedTenant;
  let staff: Staff;
  let headers: { Host: string };
  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    roti: randomUUID(),
    priceList: randomUUID(),
    taxRule: randomUUID(),
    taxSettings: randomUUID(),
  };

  async function asTenant<T>(run: (client: Client) => Promise<T>) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      const result = await run(client as unknown as Client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    tenant = await createIsolatedTenant(`obx-${randomUUID().slice(0, 6)}`);
    await owner.query(`UPDATE roles SET permissions = $2 WHERE id = $1`, [
      tenant.roleId,
      JSON.stringify([
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
        "floor.session.open_bill",
        "floor.open_bill_policy.manage",
      ]),
    ]);
    staff = await staffOfIsolatedTenant(app, tenant);
    headers = { Host: tenant.hostname };
    await seedPin(tenant.tenantId, tenant.outletId, staff.userId);
    await asTenant(async (client) => {
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1, $2, $3, 'Open Bill Konversi', 0)`,
        [ids.category, tenant.tenantId, tenant.brandId],
      );
      for (const [id, name] of [
        [ids.kopi, "Kopi Susu"],
        [ids.roti, "Roti Bakar"],
      ] as const)
        await client.query(
          `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [
            id,
            tenant.tenantId,
            tenant.brandId,
            ids.category,
            name,
            randomUUID(),
          ],
        );
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
        [ids.priceList, tenant.tenantId, tenant.outletId],
      );
      for (const [itemId, price] of [
        [ids.kopi, 25_000],
        [ids.roti, 18_000],
      ] as const)
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
        );
      await client.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                 'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
        [ids.taxSettings, tenant.tenantId, staff.userId],
      );
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'PBJT-OBC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                 '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
        [ids.taxRule, tenant.tenantId, staff.userId],
      );
    });
  });

  afterAll(async () => {
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  });

  /** A pay-first session with one placed order of about Rp118.000 + service + tax. */
  async function seatWithOrder() {
    const zone = await createZone(
      staff.client,
      { paymentMode: "pay_first", hours: ALL_DAY },
      headers,
    );
    const table = await createTable(staff.client, { zoneId: zone.id }, headers);
    const qr = await issueQr(staff.client, table.id, headers);
    const scanned = await scan(app, {
      token: qr.token,
      hostname: tenant.hostname,
    });
    expect(scanned.status).toBe(201);
    const sessionId = scanned.body.data.session.id as string;
    const guest = (test: ReturnType<ReturnType<typeof agent>["post"]>) =>
      test
        .set("Host", tenant.hostname)
        .set("Authorization", `Bearer ${scanned.body.data.sessionToken}`)
        .set(originHeader);
    const base = `/api/table-sessions/${sessionId}`;
    const client = agent(app);
    const first = await guest(client.post(`${base}/cart/lines`)).send({
      idempotencyKey: randomUUID(),
      modifierIds: [],
      menuItemId: ids.kopi,
      quantity: 4,
      expectedCartVersion: 0,
    });
    expect(first.status).toBe(201);
    const second = await guest(client.post(`${base}/cart/lines`)).send({
      idempotencyKey: randomUUID(),
      modifierIds: [],
      menuItemId: ids.roti,
      quantity: 1,
      expectedCartVersion: first.body.data.cart.version,
    });
    expect(second.status).toBe(201);
    const placed = await guest(client.post(`${base}/orders`)).send({
      expectedCartVersion: second.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    return sessionId;
  }

  const modeOf = async (sessionId: string) => {
    const { rows } = await owner.query<{ payment_mode: string }>(
      `SELECT payment_mode FROM table_sessions WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, sessionId],
    );
    return rows[0]!.payment_mode;
  };

  it("unpaid bill above the outlet limit: 409 OPEN_BILL_CONVERT_LIMIT, stays pay-first; after the limit is raised it converts", async () => {
    const sessionId = await seatWithOrder();
    // Smallest allowed limit (Rp100.000): the unpaid order is above it.
    const lowered = await putPolicy(
      staff,
      { ...validPolicy, maxBillValueIdr: 100_000 },
      tenant.outletId,
      tenant.hostname,
    );
    expect(lowered.status).toBe(200);

    const refused = await convert(
      staff,
      sessionId,
      validBody(staff),
      tenant.hostname,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("OPEN_BILL_CONVERT_LIMIT");
    expect(await modeOf(sessionId)).toBe("pay_first");
    expect(await convertAudits(tenant.tenantId, sessionId)).toHaveLength(0);

    const raised = await putPolicy(
      staff,
      { ...validPolicy, maxBillValueIdr: 1_000_000 },
      tenant.outletId,
      tenant.hostname,
    );
    expect(raised.status).toBe(200);
    const accepted = await convert(
      staff,
      sessionId,
      validBody(staff),
      tenant.hostname,
    );
    expect(accepted.status).toBe(200);
    expect(await modeOf(sessionId)).toBe("open_bill");
    const audits = await convertAudits(tenant.tenantId, sessionId);
    expect(audits).toHaveLength(1);
    // Self-approval: requester and approver are the same person.
    expect(audits[0]!.actorId).toBe(staff.userId);
  });
});
