// legend-495 G2 (tier K access). grantRoleAssignment only gives a role to a
// user who already belongs to the tenant: an assignment that is in force now
// (started, not expired) in THIS tenant, or an HRIS employee record of this
// tenant linked to that user whose status is `onboarding` or `active`
// (`employees.status`, the same set the attendance gate accepts). A new hire
// has the second and no assignment yet, so the rule must not block onboarding.
// Everything else is refused with 422 VALIDATION_ERROR.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantRoleSchema, roleTemplate } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { grantRoleAssignment } from "../services/access.service";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";
import { agent, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const TENANT_SCOPE = { type: "tenant", id: null } as const;

let tenant: IsolatedTenant;
let otherTenant: IsolatedTenant;
let ownerRoleId: string;
let financeRoleId: string;
let grantorId: string;

function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return session.body.user.id as string;
}

async function insertRole(
  tenantId: string,
  name: string,
  templateKey: "owner" | "finance",
  allowedScopeTypes: readonly string[],
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, $3, $4::jsonb, true, $5::jsonb)
     RETURNING id`,
    [
      tenantId,
      name,
      templateKey,
      JSON.stringify(roleTemplate(templateKey).permissions),
      JSON.stringify(allowedScopeTypes),
    ],
  );
  return rows[0]!.id;
}

async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  validFrom: string,
  validUntil: string | null,
) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() + $4::interval, now() + $5::interval, $6)`,
    [tenantId, userId, roleId, validFrom, validUntil, grantorId],
  );
}

async function insertEmployee(
  target: IsolatedTenant,
  userId: string,
  status: string,
) {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [target.tenantId],
    );
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Uji Grant', $5, 'pkwtt', '2025-03-01', $6)`,
      [
        id,
        target.tenantId,
        userId,
        `G2-${id.slice(0, 8).toUpperCase()}`,
        target.outletId,
        status,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function grant(userId: string, actorUserId: string = grantorId) {
  return grantRoleAssignment(
    scopedContext(tenant.tenantId),
    grantRoleSchema.parse({
      userId,
      roleId: financeRoleId,
      scope: TENANT_SCOPE,
    }),
    {
      actorUserId,
      // 5 s in the past: the service reads the DB clock, which can trail the app clock by tens of ms.
      reauthenticatedAt: new Date(Date.now() - 5_000),
      mfaVerified: true,
    },
  );
}

async function expectRefused(userId: string) {
  await expect(grant(userId)).rejects.toMatchObject({
    status: 422,
    code: "VALIDATION_ERROR",
  });
  const { rows } = await owner.query(
    "SELECT 1 FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3",
    [tenant.tenantId, userId, financeRoleId],
  );
  expect(rows).toHaveLength(0);
}

beforeAll(async () => {
  setAuditWriter({ record: async () => {} });
  tenant = await createIsolatedTenant(`g2a-${randomUUID().slice(0, 6)}`);
  otherTenant = await createIsolatedTenant(`g2b-${randomUUID().slice(0, 6)}`);
  ownerRoleId = await insertRole(tenant.tenantId, "Owner", "owner", [
    "tenant",
    "brand",
  ]);
  financeRoleId = await insertRole(tenant.tenantId, "Finance", "finance", [
    "tenant",
    "brand",
    "outlet",
  ]);
  grantorId = await signedIn("G2 Grantor");
  await assign(tenant.tenantId, grantorId, ownerRoleId, "-1 minute", null);
}, 30_000);

afterAll(async () => {
  setAuditWriter(null);
  for (const t of [tenant, otherTenant]) {
    if (!t) continue;
    await owner.query("DELETE FROM domain_event_outbox WHERE tenant_id = $1", [
      t.tenantId,
    ]);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [t.tenantId],
      );
      await client.query("DELETE FROM employees WHERE tenant_id = $1", [
        t.tenantId,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await dropIsolatedTenant(t);
  }
  await owner.end();
});

describe("legend-495 G2 the grantee already belongs to the tenant", () => {
  it("refuses a user whose only assignment has expired", async () => {
    const userId = await signedIn("G2 Expired");
    await assign(tenant.tenantId, userId, ownerRoleId, "-2 days", "-1 minute");
    await expectRefused(userId);
  });

  it("refuses a user whose only assignment has not started yet", async () => {
    const userId = await signedIn("G2 Future");
    await assign(tenant.tenantId, userId, ownerRoleId, "+1 day", null);
    await expectRefused(userId);
  });

  it("refuses a user who only belongs to another tenant", async () => {
    const userId = await signedIn("G2 Other Tenant");
    const otherRole = await insertRole(
      otherTenant.tenantId,
      "Finance",
      "finance",
      ["tenant"],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [otherTenant.tenantId, userId, otherRole],
    );
    await insertEmployee(otherTenant, userId, "active");
    await expectRefused(userId);
  });

  it("refuses a user whose HRIS employee record is terminated, resigned or suspended", async () => {
    for (const status of ["terminated", "resigned", "suspended"]) {
      const userId = await signedIn(`G2 ${status}`);
      await insertEmployee(tenant, userId, status);
      await expectRefused(userId);
    }
  });

  it("refuses a user with neither an assignment nor an employee record", async () => {
    await expectRefused(await signedIn("G2 Stranger"));
  });

  it("grants to a user with an active assignment", async () => {
    const userId = await signedIn("G2 Active");
    await assign(tenant.tenantId, userId, financeRoleId, "-1 minute", null);
    const assignment = await grant(userId);
    expect(assignment.userId).toBe(userId);
  });

  it("grants the first role to a new hire with an active HRIS record and no assignment", async () => {
    for (const status of ["onboarding", "active"]) {
      const userId = await signedIn(`G2 Hire ${status}`);
      await insertEmployee(tenant, userId, status);
      const assignment = await grant(userId);
      expect(assignment.userId).toBe(userId);
    }
  });

  it("answers 403, not 422, when the grantor has no authority and the grantee is not a member", async () => {
    const powerless = await signedIn("G2 Powerless Grantor");
    const stranger = await signedIn("G2 Probe Target");
    await expect(grant(stranger, powerless)).rejects.toMatchObject({
      status: 403,
    });
  });
});
