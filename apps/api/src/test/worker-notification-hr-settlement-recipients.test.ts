// legend-852 T3 (second-opinion finding 3): who hears `leave.rededucted_after_settlement`.
//
// The event carries the outlet of the attendance log that triggered the
// re-deduction. Expected (brief 852, finding 3): the recipients are HR users
// scoped to the employee's CURRENT HOME outlet who hold the settlement
// permission. The outlet of the attendance log must not decide the audience:
// an HR user of an old attendance outlet must not see settlement details.
//
// Assumptions (spec is silent, stated explicitly):
//  - "izin settlement" = the permission that guards GET
//    /api/hris/offboardings/:id/settlement: `hr.employee.manage` or `payroll.view`.
//    Seeded here as custom outlet-scoped roles (the `hr` template is tenant/brand scoped).
//  - Resolver output is checked by user id only, filtered to users this file
//    created (fixture users may match too).
//  - Tenant-scope users are not asserted either way.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, cafeLegendFixtures } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import type { Employee } from "@starter/shared/hris";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const tenantId = cafeLegendFixtures.tenant.id;
const homeOutlet = cafeLegendFixtures.outlets[1].id; // employee's current home
const oldAttendanceOutlet = cafeLegendFixtures.outlets[0].id; // where the flagged log was
const EVENT = "leave.rededucted_after_settlement";

const tenantCtx = (source: "session" | "job"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "tenant" },
  );

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const u = {} as Record<
  "homeHr" | "homePayroll" | "oldHr" | "homeNoPermission" | "actor",
  string
>;

async function outletUser(
  label: string,
  outletId: string | null,
  permissions: string[],
): Promise<string> {
  const scope = outletId ? "outlet" : "tenant";
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [userId, label, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4::jsonb, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `${label} ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $5, $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, roleId, outletId, scope],
  );
  return userId;
}

async function employeeHomedAt(outletId: string): Promise<Employee> {
  return createEmployee(tenantCtx("session"), u.actor, {
    userId: null,
    legalEntityId: null,
    employeeNo: `HS-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
    fullName: "Karyawan Settlement Penerima",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletId,
    employmentType: "pkwt",
    joinDate: "2040-01-02",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
}

function rededuction(employeeId: string, attendanceOutletId: string) {
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId,
    outletId: attendanceOutletId,
    name: EVENT,
    aggregateType: "leave",
    aggregateId: createUlid(),
    idempotencyKey: `${EVENT}-${randomUUID()}`,
    payloadSchemaRef: `${EVENT}.v1`,
    payload: {
      offboardingId: randomUUID(),
      employeeId,
      outletId: attendanceOutletId,
      date: "2049-05-12",
      periodYear: 2049,
      days: "1.0000",
    },
  });
}

const resolve = (event: ReturnType<typeof rededuction>) =>
  withTenant(database, tenantCtx("job"), (tx) =>
    createNotificationRecipientResolver({ email: true, push: true })(
      tenantCtx("job"),
      event,
      tx,
    ),
  );
const ours = <T extends { userId: string }>(recipients: T[]) =>
  recipients.filter((r) => createdUsers.includes(r.userId));

describe("legend-852 T3 settlement notification recipients", () => {
  beforeAll(async () => {
    u.actor = await outletUser("Actor 852", null, ["hr.employee.manage"]);
    u.homeHr = await outletUser("HR rumah", homeOutlet, ["hr.employee.manage"]);
    u.homePayroll = await outletUser("Payroll rumah", homeOutlet, [
      "payroll.view",
    ]);
    u.oldHr = await outletUser("HR absen lama", oldAttendanceOutlet, [
      "hr.employee.manage",
      "payroll.view",
    ]);
    u.homeNoPermission = await outletUser("Tanpa izin rumah", homeOutlet, [
      "hr.employee.view",
    ]);
  });

  afterAll(async () => {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUsers],
    );
    await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoles,
    ]);
    await owner.end();
    await appPool.end();
  });

  it("legend-852 reaches settlement-permitted HR of the home outlet, not HR of the old attendance outlet", async () => {
    const employee = await employeeHomedAt(homeOutlet);
    const recipients = ours(
      await resolve(rededuction(employee.id, oldAttendanceOutlet)),
    ).map((r) => r.userId);
    expect(recipients).toContain(u.homeHr);
    expect(recipients).toContain(u.homePayroll);
    expect(recipients).not.toContain(u.oldHr);
    expect(recipients).not.toContain(u.homeNoPermission);
  });

  it("legend-852 still reaches home outlet HR when the attendance outlet is the home outlet", async () => {
    const employee = await employeeHomedAt(homeOutlet);
    const recipients = ours(
      await resolve(rededuction(employee.id, homeOutlet)),
    ).map((r) => r.userId);
    expect(recipients).toContain(u.homeHr);
    expect(recipients).not.toContain(u.oldHr);
    expect(recipients).not.toContain(u.homeNoPermission);
  });

  it("legend-852 an employee homed at the old outlet notifies that outlet's HR, not the home outlet of another employee", async () => {
    const employee = await employeeHomedAt(oldAttendanceOutlet);
    const recipients = ours(
      await resolve(rededuction(employee.id, homeOutlet)),
    ).map((r) => r.userId);
    expect(recipients).toContain(u.oldHr);
    expect(recipients).not.toContain(u.homeHr);
    expect(recipients).not.toContain(u.homePayroll);
  });

  // Assumption: when the employee of the event cannot be found, the home
  // outlet is unknown, so nobody is notified. Falling back to the attendance
  // outlet would leak settlement details to HR of an outlet that may not own
  // the employee.
  it("legend-852 notifies nobody when the event employee is not found, not the attendance outlet HR", async () => {
    const all = await resolve(rededuction(randomUUID(), oldAttendanceOutlet));
    const recipients = ours(all).map((r) => r.userId);
    expect(recipients).not.toContain(u.oldHr);
    expect(recipients).not.toContain(u.homeHr);
    expect(recipients).not.toContain(u.homePayroll);
    expect(all).toEqual([]);
  });
});
