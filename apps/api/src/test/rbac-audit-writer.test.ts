// RBAC audit writer on the domain transaction (beads legend-wt33 / legend-9by4;
// PRD v1.7 §3.7 "Pemberian Role ... tercatat di audit log", §6 B audit_logs,
// TEN-03).
//
// Real PostgreSQL, real services and the real core audit writer. Proves the
// audit row commits with the domain write, rolls back with it, that a missing
// writer fails closed, and that RLS keeps audit rows inside their tenant.
//
// Assumptions: audit_logs is append-only (owner included), so the audit rows
// created here cannot be deleted; every query filters by the unique actor or
// object ids this file creates. Role names are masked as [REDACTED] (the
// writer keeps only permissions, mfaRequired and allowedScopeTypes for roles).
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  createCustomRoleSchema,
  grantRoleSchema,
  roleIdSchema,
} from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createCustomRole,
  grantRoleAssignment,
  replaceApprovalMatrix,
} from "../services/access.service.ts";
import {
  AuditUnavailableError,
  recordAudit,
  setAuditWriter,
  type AuditWriter,
} from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deleteHires, seedHire } from "./hire-seed.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

let suiteTenant: SecondTenant | undefined;
let seededTenantId: string;
let bandung: string;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdHireIds: string[] = [];
const otherTenantIds: string[] = [];

type StoredEvent = {
  action: string;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  objectType: string;
  objectId: string | null;
  maskedChanges: { before: unknown; after: unknown };
};

// A writer that really appends the audit row and then fails: the audit row
// must not survive, because it shares the domain transaction.
const writeThenFail: AuditWriter = {
  async record(entry, scope) {
    await coreAuditWriter.record(entry, scope);
    throw new Error("audit writer failed after appending");
  },
};

function scopedContext(tenantId: string = seededTenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function newUser(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [id, name, `${name.replace(/\s+/g, "-")}-${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

/** A new account that already belongs to the tenant as an HRIS hire (G2). */
async function newHire(name: string): Promise<string> {
  const userId = await newUser(name);
  createdHireIds.push(
    await seedHire(owner, {
      tenantId: seededTenantId,
      userId,
      outletId: bandung,
    }),
  );
  return userId;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [seededTenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for the seeded tenant`);
  return rows[0].id;
}

async function ownerUser(name: string): Promise<string> {
  const userId = await newUser(name);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)
     RETURNING id`,
    [seededTenantId, userId, await roleIdOf("owner")],
  );
  createdAssignmentIds.push(rows[0]!.id);
  return userId;
}

async function auditByActor(actorId: string): Promise<StoredEvent[]> {
  const { rows } = await owner.query<{ event: StoredEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'actorId' = $2 ORDER BY id`,
    [seededTenantId, actorId],
  );
  return rows.map((row) => row.event);
}

async function auditByObject(
  tenantId: string,
  objectId: string,
): Promise<StoredEvent[]> {
  const { rows } = await owner.query<{ event: StoredEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 ORDER BY id`,
    [tenantId, objectId],
  );
  return rows.map((row) => row.event);
}

const roleInput = (name: string) =>
  createCustomRoleSchema.parse({
    name,
    permissions: ["menu.item.view"],
    allowedScopeTypes: ["tenant"],
  });

async function roleCountByName(name: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM roles WHERE tenant_id = $1 AND name = $2",
    [seededTenantId, name],
  );
  return rows[0]!.count;
}

async function assignmentCountFor(userId: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
    [seededTenantId, userId],
  );
  return rows[0]!.count;
}

async function policyFingerprint(): Promise<string> {
  const { rows } = await owner.query(
    `SELECT action_type, threshold_idr, approver_role_id, levels
       FROM approval_policies WHERE tenant_id = $1
       ORDER BY action_type, threshold_idr NULLS FIRST, levels`,
    [seededTenantId],
  );
  return JSON.stringify(rows);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // Matrix replacement reads and replaces every policy of its tenant. Keep
  // this suite away from seeded policies temporarily held by parallel tests.
  suiteTenant = await createSecondTenant(owner, "rbac-audit");
  seededTenantId = suiteTenant.tenantId;
  bandung = suiteTenant.outletId;
  for (const role of cafeLegendAccessFixtures.roles.filter(
    (role) =>
      role.templateKey !== null &&
      ["owner", "supervisor", "cashier"].includes(role.templateKey),
  )) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
      [
        id,
        seededTenantId,
        role.name,
        role.templateKey,
        JSON.stringify(role.permissions),
        role.mfaRequired,
        JSON.stringify(role.allowedScopeTypes),
      ],
    );
    createdRoleIds.push(id);
  }
  setAuditWriter(coreAuditWriter);
});

afterEach(() => {
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  if (!suiteTenant) {
    await owner.end();
    return;
  }
  await owner.query("DELETE FROM approval_policies WHERE tenant_id = $1", [
    seededTenantId,
  ]);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, createdUserIds],
    );
  if (createdAssignmentIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE id = ANY($1::uuid[])",
      [createdAssignmentIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  for (const id of otherTenantIds)
    await owner.query("DELETE FROM tenants WHERE id = $1", [id]);
  await deleteHires(owner, seededTenantId, createdHireIds);
  // Access audit rows are tenant-wide (outlet_id is null), so the append-only
  // rows can remain in this disposable database without blocking outlet cleanup.
  await removeSecondTenant(owner, suiteTenant);
  if (createdUserIds.length > 0)
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  await owner.end();
});

describe("§3.7 RBAC audit commits with the domain write", () => {
  it("§3.7 role.created lands in audit_logs on the tenant with the name masked", async () => {
    const actor = await ownerUser("Audit Role Actor");
    const name = `Audit role ${randomBytes(4).toString("hex")}`;
    const role = await createCustomRole(
      scopedContext(),
      roleInput(name),
      actor,
    );
    createdRoleIds.push(role.id);

    const rows = await auditByObject(seededTenantId, role.id);
    expect(rows).toHaveLength(1);
    const [event] = rows;
    expect(event).toMatchObject({
      action: "role.created",
      tenantId: seededTenantId,
      actorType: "user",
      actorId: actor,
      objectType: "role",
      objectId: role.id,
    });
    expect(event!.maskedChanges.after).toMatchObject({ name: "[REDACTED]" });
    expect(JSON.stringify(event)).not.toContain(name);
  });

  it("§3.7 role_assignment.granted lands in audit_logs with grantor, tenant and object", async () => {
    const grantor = await ownerUser("Audit Grantor");
    const grantee = await newHire("Audit Grantee");
    const assignment = await grantRoleAssignment(
      scopedContext(),
      grantRoleSchema.parse({
        userId: grantee,
        roleId: await roleIdOf("cashier"),
        scope: { type: "outlet", id: bandung },
      }),
      {
        actorUserId: grantor,
        reauthenticatedAt: new Date(),
        mfaVerified: true,
      },
    );

    const rows = await auditByObject(seededTenantId, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "role_assignment.granted",
      tenantId: seededTenantId,
      actorType: "user",
      actorId: grantor,
      objectType: "role_assignment",
      objectId: assignment.id,
    });
  });

  it("§3.7 approval_policy.changed lands in audit_logs on the tenant", async () => {
    const actor = await ownerUser("Audit Matrix Actor");
    const supervisor = await roleIdOf("supervisor");
    await replaceApprovalMatrix(
      scopedContext(),
      {
        policies: [
          {
            actionType: "void",
            thresholdIdr: null,
            approverRoleId: roleIdSchema.parse(supervisor),
            levels: 1,
          },
        ],
      },
      actor,
    );

    const events = await auditByActor(actor);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "approval_policy.changed",
      tenantId: seededTenantId,
      actorType: "user",
      actorId: actor,
      objectType: "approval_policy",
    });
  });
});

describe("§3.7 RBAC audit rolls back with the domain write", () => {
  it("§3.7 a failing audit writer leaves no role and no audit row", async () => {
    const actor = await ownerUser("Rollback Role Actor");
    const name = `Rollback role ${randomBytes(4).toString("hex")}`;
    setAuditWriter(writeThenFail);

    await expect(
      createCustomRole(scopedContext(), roleInput(name), actor),
    ).rejects.toThrow("audit writer failed after appending");

    expect(await roleCountByName(name)).toBe(0);
    expect(await auditByActor(actor)).toEqual([]);
  });

  it("§3.7 a failing audit writer leaves no assignment and no audit row", async () => {
    const grantor = await ownerUser("Rollback Grantor");
    const grantee = await newHire("Rollback Grantee");
    setAuditWriter(writeThenFail);

    await expect(
      grantRoleAssignment(
        scopedContext(),
        grantRoleSchema.parse({
          userId: grantee,
          roleId: await roleIdOf("cashier"),
          scope: { type: "outlet", id: bandung },
        }),
        {
          actorUserId: grantor,
          reauthenticatedAt: new Date(),
          mfaVerified: true,
        },
      ),
    ).rejects.toThrow("audit writer failed after appending");

    expect(await assignmentCountFor(grantee)).toBe(0);
    expect(await auditByActor(grantor)).toEqual([]);
  });

  it("§3.7 a failing audit writer leaves the approval matrix and audit log unchanged", async () => {
    const actor = await ownerUser("Rollback Matrix Actor");
    const parkedPolicyId = randomUUID();
    // Other suites temporarily park fixture policies under action names that
    // are outside the API enum. This suite must not read their matrix.
    const parkedPolicy = await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, approver_role_id, levels)
       SELECT $1, tenant_id, 'cash_out_held_by_test', id, 1 FROM roles
        WHERE tenant_id = $2 AND template_key = 'supervisor'`,
      [parkedPolicyId, cafeLegendPlatformFixtures.tenant.id],
    );
    try {
      expect(parkedPolicy.rowCount).toBe(1);
      const before = await policyFingerprint();
      setAuditWriter(writeThenFail);

      await expect(
        replaceApprovalMatrix(
          scopedContext(),
          {
            policies: [
              {
                actionType: "void",
                thresholdIdr: null,
                approverRoleId: roleIdSchema.parse(
                  await roleIdOf("supervisor"),
                ),
                levels: 1,
              },
            ],
          },
          actor,
        ),
      ).rejects.toThrow("audit writer failed after appending");

      expect(await policyFingerprint()).toBe(before);
      expect(await auditByActor(actor)).toEqual([]);
    } finally {
      await owner.query("DELETE FROM approval_policies WHERE id = $1", [
        parkedPolicyId,
      ]);
    }
  });

  it("§3.7 an audit row appended on a transaction that later throws is absent", async () => {
    const actor = await ownerUser("Rollback Converse Actor");
    const objectId = randomUUID();
    const entry = {
      tenantId: seededTenantId,
      outletId: null,
      actorType: "user" as const,
      actorId: actor,
      deviceId: null,
      action: "role.created",
      objectType: "role",
      objectId,
      reason: null,
      before: null,
      after: { permissions: ["menu.item.view"] },
      sensitiveAccess: false,
    };
    const context = scopedContext();

    await expect(
      withTenant(db, context, async (tx) => {
        await recordAudit(entry, { tx, context });
        throw new Error("domain write failed after the audit row");
      }),
    ).rejects.toThrow("domain write failed after the audit row");
    expect(await auditByObject(seededTenantId, objectId)).toEqual([]);

    // Control: the same append on a transaction that commits is kept, so the
    // absence above comes from the rollback and not from a broken append.
    await withTenant(db, context, (tx) => recordAudit(entry, { tx, context }));
    expect(await auditByObject(seededTenantId, objectId)).toHaveLength(1);
  });
});

describe("§3.7 RBAC audit fails closed", () => {
  it("§3.7 refuses a role write with AuditUnavailableError when no writer is installed", async () => {
    const actor = await ownerUser("Closed Role Actor");
    const name = `Closed role ${randomBytes(4).toString("hex")}`;
    setAuditWriter(null);

    await expect(
      createCustomRole(scopedContext(), roleInput(name), actor),
    ).rejects.toBeInstanceOf(AuditUnavailableError);

    expect(await roleCountByName(name)).toBe(0);
    expect(await auditByActor(actor)).toEqual([]);
  });

  it("§3.7 refuses a role grant with AuditUnavailableError when no writer is installed", async () => {
    const grantor = await ownerUser("Closed Grantor");
    const grantee = await newHire("Closed Grantee");
    setAuditWriter(null);

    await expect(
      grantRoleAssignment(
        scopedContext(),
        grantRoleSchema.parse({
          userId: grantee,
          roleId: await roleIdOf("cashier"),
          scope: { type: "outlet", id: bandung },
        }),
        {
          actorUserId: grantor,
          reauthenticatedAt: new Date(),
          mfaVerified: true,
        },
      ),
    ).rejects.toBeInstanceOf(AuditUnavailableError);

    expect(await assignmentCountFor(grantee)).toBe(0);
  });
});

describe("TEN-03 audit rows stay inside their tenant", () => {
  it("TEN-03 another tenant's app connection cannot read this tenant's audit rows", async () => {
    const actor = await ownerUser("Isolation Actor");
    const role = await createCustomRole(
      scopedContext(),
      roleInput(`Isolation role ${randomBytes(4).toString("hex")}`),
      actor,
    );
    createdRoleIds.push(role.id);
    expect(await auditByObject(seededTenantId, role.id)).toHaveLength(1);

    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Audit isolation tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [otherTenant, `audit-iso-${otherTenant}`, actor],
    );

    const countSeen = (tenantId: string) =>
      withTenant(db, scopedContext(tenantId), async (tx) => {
        const byObject = await tx.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM audit_logs WHERE event->>'objectId' = ${role.id}`,
        );
        const byTenant = await tx.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = ${seededTenantId}`,
        );
        return [byObject.rows[0]!.count, byTenant.rows[0]!.count];
      });

    // The other tenant sees nothing of the seeded tenant's audit log.
    expect(await countSeen(otherTenant)).toEqual([0, 0]);
    // The owning tenant sees its own row.
    const [own] = await countSeen(seededTenantId);
    expect(own).toBe(1);
  });
});
