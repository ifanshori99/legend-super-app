// The worker must install the core audit writer (bead legend-j88cz).
// Without it `recordAudit` throws AuditUnavailableError and every worker sweep
// that audits (support access expiry, approval expiry) rolls back; the worker
// loop swallows the error per sweep, so the job silently does nothing.
//
// Expected behaviour comes from the sub-brief, not from the service code:
//   - writer unset: the sweep rejects with AuditUnavailableError, nothing changes
//   - writer installed the way the worker does it: the sweep stamps the grant,
//     audits `support_access.expired` as the system actor, emits
//     `support_access.ended`, and a second run changes nothing
//
// Assumptions (spec silent):
//   - Each support-access case runs in its own fresh tenant (and a second one
//     for the isolation case), so other suites cannot change the counts.
//     Audit and outbox rows are counted per tenant and action name, not by
//     object id.
//   - Fixtures are seeded through the public services with an injected past
//     `now` while the writer is installed (those services audit too); the
//     writer is then switched off for the "unset" cases.
//   - A grant requested 3 h ago (default read_only duration is shorter) is past
//     its `expires_at`; a write request filed 25 h ago is past its 24 h window.
//   - The approval case reuses the shared fixture tenant and its policy
//     seeding pattern from platform-approval-resolve-outcome.test.ts.
//   - worker-main starts the worker on import, so the wiring is checked on
//     its source text (comment lines removed).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  AuditUnavailableError,
  setAuditWriter,
} from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  expireDueApprovalRequests,
  openApprovalRequest,
} from "../services/platform-approval.service.ts";
import {
  expireDueSupportAccessGrants,
  requestSupportAccess,
  requestSupportWriteAccess,
} from "../services/platform-support.service.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const sharedTenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const REASON = "Memperbaiki pengaturan peran tenant atas permintaan pemilik.";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const APPROVAL_ACTION = "void";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const adminIds: string[] = [];
const userIds: string[] = [];
const tenants: SecondTenant[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const jobContext = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

async function newTenant(label: string): Promise<string> {
  const tenant = await createSecondTenant(owner, label);
  tenants.push(tenant);
  return tenant.tenantId;
}

async function newPlatformAdmin(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Super Admin Worker', $2)`,
    [id, `${id}@example.test`],
  );
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [id]);
  adminIds.push(id);
  return id;
}

/** A read_only grant that ended its window 2+ hours ago but is not yet swept. */
async function seedOverdueGrant(tenantId: string, adminId: string) {
  setAuditWriter(coreAuditWriter);
  const past = new Date(Date.now() - 3 * HOUR_MS);
  return requestSupportAccess({
    tenantId,
    actorUserId: adminId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
    }),
    mfaVerifiedAt: past.toISOString(),
    now: past,
  });
}

/** A read_write request filed 25 h ago: its 24 h approval window lapsed. */
async function seedOverdueRequest(tenantId: string, adminId: string) {
  setAuditWriter(coreAuditWriter);
  const past = new Date(Date.now() - 25 * HOUR_MS);
  return requestSupportWriteAccess({
    tenantId,
    actorUserId: adminId,
    request: { reason: REASON, durationMinutes: 30, mfaCode: "123456" },
    mfaVerifiedAt: past.toISOString(),
    now: past,
  });
}

async function grantRow(grantId: string) {
  const { rows } = await owner.query<{ expiry_recorded_at: Date | null }>(
    "SELECT expiry_recorded_at FROM support_access_grants WHERE id = $1",
    [grantId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function requestStatus(requestId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM support_access_requests WHERE id = $1",
    [requestId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.status;
}

async function auditRows(tenantId: string, action: string) {
  const { rows } = await owner.query<{
    event: { actorType: string; actorId: string | null };
  }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenantId, action],
  );
  return rows.map((row) => row.event);
}

async function outboxCount(tenantId: string, name: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2`,
    [tenantId, name],
  );
  return rows.length;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [sharedTenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

beforeAll(async () => {
  // Backdated like other suites: the container clock may drift from Node's.
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
      [sharedTenantId, APPROVAL_ACTION],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
    [sharedTenantId, APPROVAL_ACTION],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, NULL, $3, 1)`,
    [sharedTenantId, APPROVAL_ACTION, await roleIdOf("supervisor")],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `WITH gone AS (
       DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])
     )
     DELETE FROM support_access_requests WHERE super_admin_user_id = ANY($1::text[])`,
    [adminIds],
  );
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
    [sharedTenantId, userIds],
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2",
    [sharedTenantId, APPROVAL_ACTION],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [sharedTenantId, userIds],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [adminIds],
  );
  // Audit rows are append-only and may block these deletes; the disposable
  // database is dropped after the run, so a failed teardown is harmless.
  for (const tenant of tenants)
    await removeSecondTenant(owner, tenant).catch(() => undefined);
  await owner.end();
});

describe("legend-j88cz support access expiry sweep and the audit writer", () => {
  it("legend-j88cz without a writer the sweep rolls back with AuditUnavailableError and changes nothing", async () => {
    const tenantId = await newTenant("j88cz-unset");
    const grant = await seedOverdueGrant(tenantId, await newPlatformAdmin());

    setAuditWriter(null);
    await expect(
      expireDueSupportAccessGrants(jobContext(tenantId), new Date()),
    ).rejects.toBeInstanceOf(AuditUnavailableError);

    expect((await grantRow(grant.id)).expiry_recorded_at).toBeNull();
    expect(await auditRows(tenantId, "support_access.expired")).toHaveLength(0);
    expect(await outboxCount(tenantId, "support_access.ended")).toBe(0);
  });

  it("legend-j88cz with the writer installed like the worker the sweep stamps the grant, audits once as system and is idempotent", async () => {
    const tenantId = await newTenant("j88cz-a");
    const otherTenantId = await newTenant("j88cz-b");
    const grant = await seedOverdueGrant(tenantId, await newPlatformAdmin());
    const otherGrant = await seedOverdueGrant(
      otherTenantId,
      await newPlatformAdmin(),
    );

    setAuditWriter(coreAuditWriter);
    await expireDueSupportAccessGrants(jobContext(tenantId), new Date());

    expect((await grantRow(grant.id)).expiry_recorded_at).not.toBeNull();
    const audit = await auditRows(tenantId, "support_access.expired");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "system", actorId: null });
    expect(await outboxCount(tenantId, "support_access.ended")).toBe(1);

    // Tenant B's overdue grant is untouched by the sweep of tenant A.
    expect((await grantRow(otherGrant.id)).expiry_recorded_at).toBeNull();
    expect(
      await auditRows(otherTenantId, "support_access.expired"),
    ).toHaveLength(0);
    expect(await outboxCount(otherTenantId, "support_access.ended")).toBe(0);

    // A second run finds nothing left to do.
    await expireDueSupportAccessGrants(jobContext(tenantId), new Date());
    expect(await auditRows(tenantId, "support_access.expired")).toHaveLength(1);
    expect(await outboxCount(tenantId, "support_access.ended")).toBe(1);
  });

  it("legend-j88cz the same sweep expires a pending request past its approval window and audits it", async () => {
    const tenantId = await newTenant("j88cz-req");
    const adminId = await newPlatformAdmin();
    const request = await seedOverdueRequest(tenantId, adminId);
    expect(await requestStatus(request.id)).toBe("pending");

    setAuditWriter(null);
    await expect(
      expireDueSupportAccessGrants(jobContext(tenantId), new Date()),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(await requestStatus(request.id)).toBe("pending");

    setAuditWriter(coreAuditWriter);
    await expireDueSupportAccessGrants(jobContext(tenantId), new Date());
    expect(await requestStatus(request.id)).toBe("expired");
    const audit = await auditRows(tenantId, "support_access.request_expired");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "system", actorId: null });
  });
});

describe("legend-j88cz approval expiry sweep and the audit writer", () => {
  it("legend-j88cz an overdue approval request rejects without a writer and expires with one", async () => {
    const userId = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Kasir worker audit', $2)`,
      [userId, `${userId}@example.test`],
    );
    userIds.push(userId);
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [sharedTenantId, userId, await roleIdOf("cashier"), bandung],
    );
    const context = jobContext(sharedTenantId);
    setAuditWriter(coreAuditWriter);
    const opened = await withTenant(db, context, (tx) =>
      openApprovalRequest(tx, context, {
        sourceModule: "payment",
        actionType: APPROVAL_ACTION,
        objectType: "order",
        objectId: randomUUID(),
        amountIdr: null,
        outletId: bandung,
        source: "user",
        requestedBy: userId,
        requestReason: "Pelanggan membatalkan pesanan sebelum dapur mulai.",
        deadlineMinutes: 10,
        now: new Date(Date.now() - 20 * MINUTE_MS),
      }),
    );
    if (!opened.required) throw new Error("expected an approval requirement");
    const statusOf = async () =>
      (
        await owner.query<{ status: string }>(
          "SELECT status FROM approval_requests WHERE id = $1",
          [opened.request.id],
        )
      ).rows[0]?.status;
    const expiredAudits = async () =>
      (await auditRows(sharedTenantId, "approval.expired")).length;
    const auditsBefore = await expiredAudits();

    setAuditWriter(null);
    await expect(expireDueApprovalRequests(context)).rejects.toBeInstanceOf(
      AuditUnavailableError,
    );
    expect(await statusOf()).toBe("pending");
    expect(await expiredAudits()).toBe(auditsBefore);

    setAuditWriter(coreAuditWriter);
    await expireDueApprovalRequests(context);
    expect(await statusOf()).toBe("expired");
    expect(await expiredAudits()).toBeGreaterThan(auditsBefore);
  });
});

describe("legend-j88cz worker-main wiring", () => {
  const source = readFileSync(
    new URL("../worker-main.ts", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const call = /^setAuditWriter\(\s*coreAuditWriter\s*\)/m.exec(source);

  it("legend-j88cz worker-main imports coreAuditWriter and installs it at top level before the worker starts", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bcoreAuditWriter\b[^}]*\}\s*from\s*["'][^"']*core-audit-writer/,
    );
    // Column 0 means top level, not inside a function or callback.
    expect(call).not.toBeNull();
    // Call sites only: an import of registerAuditRetentionJob is not a start.
    const startMarkers = [
      /\brelay\.start\(/,
      /\bruntime\.start\(/,
      /\bregisterAuditRetentionJob\(\s*\{/,
    ]
      .map((marker) => source.search(marker))
      .filter((index) => index >= 0);
    expect(startMarkers.length).toBeGreaterThan(0);
    expect(call!.index).toBeLessThan(Math.min(...startMarkers));
  });

  it("legend-j88cz fails loudly when the worker has no audit writer", () => {
    expect(
      call,
      "legend-j88cz: worker-main.ts never calls setAuditWriter(coreAuditWriter) at top level; every audited worker sweep (support access expiry, approval expiry) throws AuditUnavailableError and silently does nothing",
    ).not.toBeNull();
  });
});
