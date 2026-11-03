// First tenant admin provisioning and platform org audit (PRD v1.7 §3 F4 flow
// R steps 2-3, TEN-06, TEN-04; beads legend-2ign, legend-bd95).
//
// Calls the services directly against the disposable PostgreSQL database: the
// app pool runs as legend_app (RLS applies), checks read back as the owner.
import { randomBytes, randomUUID } from "node:crypto";
import { idr } from "@starter/shared/core";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { CreateTenantInput } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { roleAssignments } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import {
  AuditUnavailableError,
  setAuditWriter,
} from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { provisionFirstTenantAdmin } from "../services/platform-admin-provision.service.ts";
import {
  createTenant,
  setTenantPackage,
  setTenantStatus,
} from "../services/platform-org.service.ts";

const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let actorUserId: string;

const limits: CreateTenantInput["limits"] = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: idr(0),
  aiCostCapIdr: idr(50_000),
  emailCostCapIdr: idr(10_000),
};

function randomNumber(): string {
  return `62812${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`;
}

function tenantInput(
  firstAdmin: Partial<CreateTenantInput["firstAdmin"]> = {},
): CreateTenantInput {
  return {
    slug: `adm-${randomBytes(4).toString("hex")}`,
    name: "Uji Admin Pertama",
    plan: "lengkap",
    deploymentMode: "shared",
    featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
    limits,
    firstAdmin: {
      name: "Admin Pertama",
      whatsapp: randomNumber(),
      email: null,
      ...firstAdmin,
    },
  };
}

function scope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function adminAssignments(tenantId: string) {
  const { rows } = await owner.query<{
    id: string;
    user_id: string;
    scope_type: string;
    scope_id: string | null;
    valid_until: Date | null;
    assigned_by: string;
  }>(
    `SELECT ra.id, ra.user_id, ra.scope_type, ra.scope_id, ra.valid_until, ra.assigned_by
       FROM role_assignments ra JOIN roles r
         ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.template_key = 'tenant_admin'`,
    [tenantId],
  );
  return rows;
}

async function auditActions(tenantId: string) {
  const { rows } = await owner.query<{
    event: {
      action: string;
      actorId: string | null;
      reason: string | null;
      maskedChanges: unknown;
    };
  }>("SELECT event FROM audit_logs WHERE tenant_id = $1 ORDER BY id", [
    tenantId,
  ]);
  return rows.map((row) => row.event);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  actorUserId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Super Admin Uji', $2, true)`,
    [actorUserId, `platform-${actorUserId}@example.com`],
  );
  setAuditWriter(coreAuditWriter);
});

afterEach(() => {
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  await owner.end();
});

describe("First tenant admin (flow R steps 2-3)", () => {
  it("TEN-06 creates the tenant with an invited tenant_admin account in one transaction", async () => {
    const input = tenantInput({
      email: `Admin-${randomBytes(4).toString("hex")}@Example.com`,
    });
    const tenant = await createTenant(input, actorUserId);

    const assignments = await adminAssignments(tenant.id);
    expect(assignments).toHaveLength(1);
    const [assignment] = assignments;
    expect(assignment).toMatchObject({
      scope_type: "tenant",
      scope_id: null,
      valid_until: null,
      assigned_by: actorUserId,
    });

    // An invited account: unverified, no password, no session, no token.
    const { rows: users } = await owner.query<{
      email: string;
      email_verified: boolean;
      name: string;
    }>('SELECT email, email_verified, name FROM "user" WHERE id = $1', [
      assignment!.user_id,
    ]);
    expect(users[0]).toEqual({
      email: input.firstAdmin.email!.toLowerCase(),
      email_verified: false,
      name: "Admin Pertama",
    });
    const secrets = await owner.query(
      `SELECT 1 FROM account WHERE user_id = $1
       UNION ALL SELECT 1 FROM session WHERE user_id = $1`,
      [assignment!.user_id],
    );
    expect(secrets.rowCount).toBe(0);

    // The number is the admin's login proof (WhatsApp reverse OTP): stored as
    // a keyed digest, sealed, not yet verified.
    const digest = await whatsAppDigest(input.firstAdmin.whatsapp);
    const { rows: identities } = await owner.query<{
      user_id: string;
      verified_at: Date | null;
      value_encrypted: string;
    }>(
      `SELECT user_id, verified_at, value_encrypted FROM user_identities
        WHERE type = 'whatsapp' AND value_hash = $1`,
      [digest],
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user_id).toBe(assignment!.user_id);
    expect(identities[0]!.verified_at).toBeNull();
    expect(identities[0]!.value_encrypted).not.toContain(
      input.firstAdmin.whatsapp,
    );

    // The invitation trigger: tenant.created names the admin, in the outbox.
    const { rows: outbox } = await owner.query<{
      event: { name: string; payload: Record<string, unknown> };
    }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'tenant.created'`,
      [tenant.id],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.event.payload).toMatchObject({
      slug: input.slug,
      firstAdminUserId: assignment!.user_id,
    });
  });

  it("TEN-06 TEN-04 audits the tenant creation and the admin grant on the tenant, without PII", async () => {
    const input = tenantInput({
      email: `pii-${randomBytes(4).toString("hex")}@example.com`,
    });
    const tenant = await createTenant(input, actorUserId);
    const events = await auditActions(tenant.id);
    expect(events.map((event) => event.action).sort()).toEqual([
      "role_assignment.granted",
      "tenant.created",
    ]);
    for (const event of events) expect(event.actorId).toBe(actorUserId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(input.firstAdmin.whatsapp);
    expect(serialized).not.toContain(input.firstAdmin.email!);
    expect(serialized).not.toContain(input.firstAdmin.name);
  });

  it("TEN-06 the first admin resolves the tenant_admin permissions in the new tenant", async () => {
    const tenant = await createTenant(tenantInput(), actorUserId);
    const [assignment] = await adminAssignments(tenant.id);
    const context = scope(tenant.id);
    const data = await loadTenantAccess(context, assignment!.user_id);
    const snapshot = resolveAccessSnapshot({
      tenant: context.tenant,
      userId: assignment!.user_id,
      ...data,
      mfaVerified: false,
      now: new Date(),
    });
    expect(snapshot.templateKeys).toEqual(["tenant_admin"]);
    expect(snapshot.mfaRequired).toBe(true);
    for (const permission of [
      "access.role.assign",
      "org.structure.manage",
      "org.settings.manage",
      "audit.log.view",
    ] as const)
      expect(snapshot.allows(permission, { type: "tenant" })).toBe(true);
    // PRD §3.7: Admin Tenant "tidak otomatis memiliki kewenangan keuangan".
    expect(snapshot.allows("payroll.approve", { type: "tenant" })).toBe(false);
    expect(snapshot.allows("report.financial.view", { type: "tenant" })).toBe(
      false,
    );
  });

  it("TEN-06 TEN-01 cross-tenant denial: the new admin holds nothing in another tenant", async () => {
    const tenant = await createTenant(tenantInput(), actorUserId);
    const [assignment] = await adminAssignments(tenant.id);
    const other = scope(seededTenantId);
    const data = await loadTenantAccess(other, assignment!.user_id);
    expect(data.assignments).toHaveLength(0);
    const snapshot = resolveAccessSnapshot({
      tenant: other.tenant,
      userId: assignment!.user_id,
      ...data,
      mfaVerified: false,
      now: new Date(),
    });
    expect(snapshot.permissions).toHaveLength(0);
    expect(snapshot.allows("access.role.assign", { type: "tenant" })).toBe(
      false,
    );
    // RLS: from another tenant's context the new tenant's grant is invisible.
    const visible = await withTenant(db, other, (tx) =>
      tx
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(eq(roleAssignments.id, assignment!.id)),
    );
    expect(visible).toHaveLength(0);
  });

  it("TEN-06 reuses the account a WhatsApp number already belongs to", async () => {
    const whatsapp = randomNumber();
    const first = await createTenant(tenantInput({ whatsapp }), actorUserId);
    const second = await createTenant(tenantInput({ whatsapp }), actorUserId);
    const [a] = await adminAssignments(first.id);
    const [b] = await adminAssignments(second.id);
    expect(b!.user_id).toBe(a!.user_id);
    const digest = await whatsAppDigest(whatsapp);
    const identities = await owner.query(
      "SELECT 1 FROM user_identities WHERE type = 'whatsapp' AND value_hash = $1",
      [digest],
    );
    expect(identities.rowCount).toBe(1);
  });

  it("TEN-06 reuses a verified email account but never claims an unverified one", async () => {
    const verifiedId = randomUUID();
    const verifiedEmail = `verified-${randomBytes(4).toString("hex")}@example.com`;
    const unverifiedId = randomUUID();
    const unverifiedEmail = `unverified-${randomBytes(4).toString("hex")}@example.com`;
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES
         ($1, 'Terverifikasi', $2, true), ($3, 'Belum', $4, false)`,
      [verifiedId, verifiedEmail, unverifiedId, unverifiedEmail],
    );

    const verifiedInput = tenantInput({ email: verifiedEmail });
    const reused = await createTenant(verifiedInput, actorUserId);
    const [reusedGrant] = await adminAssignments(reused.id);
    expect(reusedGrant!.user_id).toBe(verifiedId);
    // A possibly mistyped number is not attached to an existing account.
    const attached = await owner.query(
      "SELECT 1 FROM user_identities WHERE value_hash = $1",
      [await whatsAppDigest(verifiedInput.firstAdmin.whatsapp)],
    );
    expect(attached.rowCount).toBe(0);

    const unverifiedInput = tenantInput({ email: unverifiedEmail });
    const fresh = await createTenant(unverifiedInput, actorUserId);
    const [freshGrant] = await adminAssignments(fresh.id);
    expect(freshGrant!.user_id).not.toBe(unverifiedId);
    const { rows } = await owner.query<{ email: string }>(
      'SELECT email FROM "user" WHERE id = $1',
      [freshGrant!.user_id],
    );
    expect(rows[0]!.email).toMatch(/^[0-9a-f]{64}@wa\.invalid$/);
  });

  it("TEN-06 provisioning is idempotent per tenant and account", async () => {
    const input = tenantInput();
    const tenant = await createTenant(input, actorUserId);
    const [before] = await adminAssignments(tenant.id);
    const context = scope(tenant.id);
    const again = await withTenant(db, context, (tx) =>
      provisionFirstTenantAdmin(tx, context, input.firstAdmin, {
        actorUserId,
        now: new Date(),
      }),
    );
    expect(again.assignmentId).toBe(before!.id);
    expect(again.account).toBe("reused");
    expect(await adminAssignments(tenant.id)).toHaveLength(1);
  });

  it("TEN-06 rolls back tenant, account and grant when the audit write fails", async () => {
    const input = tenantInput({
      email: `rollback-${randomBytes(4).toString("hex")}@example.com`,
    });
    setAuditWriter({
      async record() {
        throw new Error("audit store down");
      },
    });
    await expect(createTenant(input, actorUserId)).rejects.toThrow(
      "audit store down",
    );
    setAuditWriter(null);
    await expect(createTenant(input, actorUserId)).rejects.toBeInstanceOf(
      AuditUnavailableError,
    );
    setAuditWriter(coreAuditWriter);

    const tenantRows = await owner.query(
      "SELECT 1 FROM tenants WHERE slug = $1",
      [input.slug],
    );
    expect(tenantRows.rowCount).toBe(0);
    const userRows = await owner.query(
      'SELECT 1 FROM "user" WHERE email = $1',
      [input.firstAdmin.email],
    );
    expect(userRows.rowCount).toBe(0);
    const identityRows = await owner.query(
      "SELECT 1 FROM user_identities WHERE value_hash = $1",
      [await whatsAppDigest(input.firstAdmin.whatsapp)],
    );
    expect(identityRows.rowCount).toBe(0);

    // The same input succeeds once the audit log is back: nothing was left.
    const tenant = await createTenant(input, actorUserId);
    expect(await adminAssignments(tenant.id)).toHaveLength(1);
  });

  it("TEN-06 refuses a banned account and leaves no tenant behind", async () => {
    const whatsapp = randomNumber();
    const first = await createTenant(tenantInput({ whatsapp }), actorUserId);
    const [grant] = await adminAssignments(first.id);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      grant!.user_id,
    ]);
    const input = tenantInput({ whatsapp });
    await expect(createTenant(input, actorUserId)).rejects.toMatchObject({
      status: 422,
    });
    const tenantRows = await owner.query(
      "SELECT 1 FROM tenants WHERE slug = $1",
      [input.slug],
    );
    expect(tenantRows.rowCount).toBe(0);
  });
});

describe("Platform org mutations are audited (legend-bd95)", () => {
  it("TEN-04 TEN-06 status and package changes write audit rows on the tenant with the reason", async () => {
    const tenant = await createTenant(tenantInput(), actorUserId);
    await setTenantStatus(
      tenant.id,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    // A no-op status change is not a change and writes nothing.
    await setTenantStatus(
      tenant.id,
      { status: "suspended", reason: "Masih belum membayar tagihan." },
      actorUserId,
    );
    await setTenantPackage(
      tenant.id,
      {
        plan: "outlet-dasar",
        featureFlags: { modules: ["pos"], integrationProviders: [] },
        limits: { ...limits, maxOutlets: 1 },
        reason: "Turun ke paket outlet dasar.",
      },
      actorUserId,
    );
    const events = await auditActions(tenant.id);
    const status = events.filter(
      (event) => event.action === "tenant.status_changed",
    );
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      actorId: actorUserId,
      reason: "Tidak membayar tagihan bulan ini.",
    });
    const pkg = events.filter(
      (event) => event.action === "tenant.package_changed",
    );
    expect(pkg).toHaveLength(1);
    expect(pkg[0]).toMatchObject({
      actorId: actorUserId,
      reason: "Turun ke paket outlet dasar.",
    });
  });

  it("TEN-04 a status change rolls back when the audit log is unavailable", async () => {
    const tenant = await createTenant(tenantInput(), actorUserId);
    setAuditWriter(null);
    await expect(
      setTenantStatus(
        tenant.id,
        { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
        actorUserId,
      ),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    setAuditWriter(coreAuditWriter);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [tenant.id],
    );
    expect(rows[0]!.status).toBe("active");
  });
});
