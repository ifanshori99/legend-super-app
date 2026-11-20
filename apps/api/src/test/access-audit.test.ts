// Audit wiring for RBAC writes (bead legend-vbws / legend-wt33; PRD v1.7 §3.7
// "Pemberian Role ... tercatat di audit log", §6 B audit_logs, TEN-03).
//
// No test writer is installed here: the API bootstrap installs the core audit
// writer, so these tests prove that role and assignment writes no longer fail
// with 503 and that the row lands in audit_logs, on the tenant, with sensitive
// fields masked.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  grantRoleSchema,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  endRoleAssignment,
  grantRoleAssignment,
} from "../services/access.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { deleteHires, seedHire } from "./hire-seed";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung: string = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdHireIds: string[] = [];

function scopedContext(tenantId = seededTenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function signedIn(name = "Audit RBAC user") {
  const client = agent(app);
  const email = await signUp(client, name);
  // AUTH-05 (legend-qfvu): /api/access is back office and stays closed until
  // the session verified a second factor; this suite tests the audit wiring,
  // so it marks the session verified (the real TOTP path has its own suite).
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [seededTenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for the seeded tenant`);
  return rows[0].id;
}

async function assign(userId: string, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)
     RETURNING id`,
    [seededTenantId, userId, await roleIdOf(templateKey)],
  );
  createdAssignmentIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function auditRows(objectId: string) {
  const { rows } = await owner.query<{
    tenant_id: string;
    event: {
      action: string;
      tenantId: string;
      actorType: string;
      actorId: string | null;
      objectType: string;
      maskedChanges: { before: unknown; after: unknown };
    };
  }>(
    `SELECT tenant_id, event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2
     ORDER BY event->>'createdAt', id`,
    [seededTenantId, objectId],
  );
  return rows;
}

afterAll(async () => {
  await deleteHires(owner, seededTenantId, createdHireIds);
  if (createdAssignmentIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE id = ANY($1::uuid[])",
      [createdAssignmentIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  await owner.end();
});

describe("§3.7 RBAC writes append to audit_logs (legend-wt33)", () => {
  it("§3.7 TEN-03 role create and update are audited instead of returning 503", async () => {
    const admin = await signedIn("Audit Role Admin");
    await assign(admin.userId, "owner");

    const created = await admin.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Audited role ${randomBytes(4).toString("hex")}`,
        permissions: ["menu.item.view"],
        allowedScopeTypes: ["tenant"],
      });
    expect(created.status).toBe(201);
    const roleId = created.body.data.id as string;
    createdRoleIds.push(roleId);

    const [createdAudit] = await auditRows(roleId);
    expect(createdAudit).toMatchObject({
      tenant_id: seededTenantId,
      event: {
        action: "role.created",
        tenantId: seededTenantId,
        actorType: "user",
        actorId: admin.userId,
        objectType: "role",
      },
    });
    // The role id and permission codes are readable; the role name is PII-like
    // in the audit vocabulary and stays redacted (default-deny masking).
    expect(createdAudit!.event.maskedChanges.after).toMatchObject({
      name: "[REDACTED]",
      permissions: ["menu.item.view"],
    });

    const updated = await admin.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({ name: `Audited role renamed ${randomBytes(4).toString("hex")}` });
    expect(updated.status).toBe(200);
    const rows = await auditRows(roleId);
    expect(rows.map((row) => row.event.action)).toEqual([
      "role.created",
      "role.updated",
    ]);
    expect(rows[1]!.event.actorId).toBe(admin.userId);
  });

  it("§3.7 TEN-03 assignment grant and end are audited on the tenant transaction", async () => {
    const grantor = await signedIn("Audit Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedIn("Audit Grantee");
    // G2: the grantee is a new hire of the tenant (HRIS record, no role yet).
    createdHireIds.push(
      await seedHire(owner, {
        tenantId: seededTenantId,
        userId: grantee.userId,
        outletId: bandung,
      }),
    );

    const assignment = await grantRoleAssignment(
      scopedContext(),
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("cashier"),
        scope: { type: "outlet", id: bandung },
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: new Date(Date.now() - 5_000),
        mfaVerified: true,
      },
    );
    createdAssignmentIds.push(assignment.id);

    const granted = await auditRows(assignment.id);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      tenant_id: seededTenantId,
      event: {
        action: "role_assignment.granted",
        tenantId: seededTenantId,
        actorId: grantor.userId,
        objectType: "role_assignment",
      },
    });
    expect(granted[0]!.event.maskedChanges.after).toMatchObject({
      userId: grantee.userId,
      scope: { type: "outlet", id: bandung },
    });

    const ended = await endRoleAssignment(
      scopedContext(),
      assignment.id,
      { reason: "Selesai uji audit." },
      grantor.userId,
    );
    expect(ended.validUntil).not.toBeNull();
    const rows = await auditRows(assignment.id);
    expect(rows.map((row) => row.event.action)).toEqual([
      "role_assignment.granted",
      "role_assignment.ended",
    ]);
    expect(rows[1]!.event.maskedChanges.before).toMatchObject({
      userId: grantee.userId,
    });
  });
});
