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
import { createUlid, outletIdSchema } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import type { Employee } from "@starter/shared/hris";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
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
// Own tenant, brand, entity and outlets: createEmployee counts seats per tenant
// against `limits.maxActiveEmployees` (QUOTA_EXCEEDED "Kuota paket sudah
// tercapai."), so sharing the fixture tenant with other files that create
// employees concurrently exhausts the quota (same pattern as
// hris-leave-release-event-db.test.ts).
const tenantId = randomUUID();
const homeOutlet = outletIdSchema.parse(randomUUID()); // employee's current home
const oldAttendanceOutlet = outletIdSchema.parse(randomUUID()); // where the flagged log was
const EVENT = "leave.rededucted_after_settlement";

const tenantCtx = (source: "session" | "job"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "tenant" },
  );

const createdUsers: string[] = [];
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
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    const fixture = cafeLegendPlatformFixtures.tenant;
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Settlement recipients tenant', $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        `wnhs-${tenantId}`,
        fixture.plan,
        fixture.status,
        fixture.deploymentMode,
        JSON.stringify(fixture.featureFlags),
        JSON.stringify(fixture.limits),
        fixture.createdBy,
      ],
    );
    const brandId = randomUUID();
    const entityId = randomUUID();
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'wnhs', 'Settlement brand')`,
      [brandId, tenantId],
    );
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Settlement entity', false)`,
      [entityId, tenantId],
    );
    for (const [index, outletId] of [oldAttendanceOutlet, homeOutlet].entries())
      await owner.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Settlement outlet', 'Jl. Uji', 'Asia/Jakarta', $6, 'active')`,
        [
          outletId,
          tenantId,
          brandId,
          entityId,
          `WNHS-${index + 1}`,
          JSON.stringify(
            cafeLegendPlatformFixtures.outlets[index].openingHours,
          ),
        ],
      );
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
    // Leave/HR services write append-only audit_logs rows with outlet_id (FK to
    // outlets): disable the trigger for one purge so the tenant can be removed
    // (same pattern as hris-leave-release-event-db.test.ts).
    const purge = await owner.connect();
    try {
      await purge.query("BEGIN");
      await purge.query(
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only",
      );
      await purge.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
        tenantId,
      ]);
      await purge.query(
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only",
      );
      await purge.query("COMMIT");
    } catch (error) {
      await purge.query("ROLLBACK");
      throw error;
    } finally {
      purge.release();
    }
    for (const statement of [
      "DELETE FROM employees WHERE tenant_id = $1",
      "DELETE FROM role_assignments WHERE tenant_id = $1",
      "DELETE FROM outlets WHERE tenant_id = $1",
      "DELETE FROM legal_entities WHERE tenant_id = $1",
      "DELETE FROM brands WHERE tenant_id = $1",
      "DELETE FROM roles WHERE tenant_id = $1",
      "DELETE FROM tenants WHERE id = $1",
    ])
      await owner.query(statement, [tenantId]);
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
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
