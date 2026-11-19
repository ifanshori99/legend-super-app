// legend-ktc4d (tier K, auth): the platform Super Admin appoints or replaces a
// tenant Owner from the Platform Panel (founder decision Q44), with MFA and an
// audit trail. Afterwards Owners grant Owners through the normal tenant path
// (legend-7vsby rules stay as they are).
//
// HTTP tests run the real Express app, Better Auth, the TOTP verifier and
// PostgreSQL (RLS). Every test creates its own tenant through
// POST /api/platform/tenants, so it starts with seeded role templates and one
// tenant_admin and no Owner.
//
// Assumptions (spec/brief ambiguity):
// - A success answers 201 { data: TenantOwnerAssignment }; zod failures
//   (empty reason, bad body) answer 422; service refusals use FORBIDDEN 403,
//   NOT_FOUND 404, CONFLICT 409, VALIDATION_ERROR 422.
// - mfaCode is a real TOTP of the caller's enrolled factor (the route
//   re-verifies it per request, like support access). The helper below resets
//   the factor's single-use step so each request can carry a valid code.
// - Self-appointment is only reachable when the Super Admin is also a member
//   of the tenant, so that test gives the admin a tenant_admin assignment.
// - The `cause` of a tenant_owner.denied audit event is asserted by searching
//   the stored event JSON, not a fixed field path.
// - An invite whose WhatsApp number already belongs to a tenant member answers
//   account "reused" with that member's userId.
// - Only valid_until-null Owner rows count as "already Owner" (409); a
//   temporary Owner can be (re)appointed as a new permanent row. The old
//   temporary row is left untouched and not asserted on.
// - Active/ended checks compare timestamps with the API clock, not the
//   database clock (the container clock may drift).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  grantRoleSchema,
  roleTemplate,
  type PermissionCode,
} from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { AssignTenantOwnerInput } from "@starter/shared/platform";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import { grantRoleAssignment } from "../services/access.service";
import { assignTenantOwner } from "../services/platform-tenant-owner.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const platformAdminIds: string[] = [];

const REASON =
  "Pemilik lama mengundurkan diri, pemilik baru ditunjuk Super Admin.";
const TENANT_SCOPE = { type: "tenant", id: null } as const;
const OWNER_CODES_WITHOUT_WRITEOFF: readonly PermissionCode[] = roleTemplate(
  "owner",
).permissions.filter((code) => code !== "pos.receipt.writeoff");

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

const randomWhatsapp = () =>
  `628${Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("")}`;

type Client = ReturnType<typeof agent>;
type Admin = {
  client: Client;
  userId: string;
  /** A valid, unused TOTP code for this admin's enrolled factor. */
  code: () => Promise<string>;
  /** A six-digit code that matches no step near now. */
  wrongCode: () => string;
};

/** Platform Super Admin with a real enrolled, verified TOTP factor. */
async function platformAdmin(name = "Super Admin Owner"): Promise<Admin> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  platformAdminIds.push(userId);

  const enroll = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enroll.status).toBe(201);
  const { factorId, secretBase32 } = enroll.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status).toBe(200);

  return {
    client,
    userId,
    code: async () => {
      // A TOTP step is single-use; clear it so every request gets a valid code.
      await owner.query(
        `UPDATE mfa_factors
            SET last_used_step = NULL, failed_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [factorId],
      );
      return totpCode(secretBase32, totpStep(new Date()));
    },
    wrongCode: () => {
      const now = totpStep(new Date());
      const valid = new Set(
        [-2, -1, 0, 1, 2].map((delta) => totpCode(secretBase32, now + delta)),
      );
      return ["000000", "111111", "222222", "333333"].find(
        (candidate) => !valid.has(candidate),
      )!;
    },
  };
}

function tenantBody(slug: string, whatsapp = randomWhatsapp()) {
  return {
    slug,
    name: "Uji Owner Platform",
    plan: "lengkap",
    deploymentMode: "shared",
    featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
    limits,
    firstAdmin: { name: "Admin Pertama", whatsapp, email: null },
  };
}

/** A tenant with seeded templates, one tenant_admin and no Owner. */
async function newTenant(admin: Admin) {
  const whatsapp = randomWhatsapp();
  const created = await admin.client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send(tenantBody(`owner-${randomBytes(4).toString("hex")}`, whatsapp));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;
  const { rows } = await owner.query<{ id: string; user_id: string }>(
    `SELECT ra.id, ra.user_id FROM role_assignments ra JOIN roles r
       ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.template_key = 'tenant_admin'
        AND ra.scope_type = 'tenant'`,
    [tenantId],
  );
  expect(rows).toHaveLength(1);
  return {
    tenantId,
    firstAdminUserId: rows[0]!.user_id,
    firstAdminAssignmentId: rows[0]!.id,
    firstAdminWhatsapp: whatsapp,
  };
}

const invite = (whatsapp = randomWhatsapp()) => ({
  invite: { name: "Pemilik Baru", whatsapp, email: null },
});

const ownersPath = (tenantId: string) =>
  `/api/platform/tenants/${tenantId}/owners`;
const replacePath = (tenantId: string, assignmentId: string) =>
  `${ownersPath(tenantId)}/${assignmentId}/replace`;

/** Body with a fresh valid mfaCode; `patch` overrides (undefined drops a key). */
async function payload(
  admin: Admin,
  account: object,
  patch: Record<string, unknown> = {},
) {
  return { account, reason: REASON, mfaCode: await admin.code(), ...patch };
}

async function appoint(
  admin: Admin,
  tenantId: string,
  account: object,
  patch: Record<string, unknown> = {},
) {
  return admin.client
    .post(ownersPath(tenantId))
    .set(originHeader)
    .send(await payload(admin, account, patch));
}

async function replace(
  admin: Admin,
  tenantId: string,
  assignmentId: string,
  account: object,
  patch: Record<string, unknown> = {},
) {
  return admin.client
    .post(replacePath(tenantId, assignmentId))
    .set(originHeader)
    .send(await payload(admin, account, patch));
}

/** Active tenant-scope Owner assignments, judged on the DATABASE clock. */
async function activeOwners(tenantId: string) {
  const { rows } = await owner.query<{
    id: string;
    user_id: string;
    valid_from: Date;
    valid_until: Date | null;
  }>(
    `SELECT ra.id, ra.user_id, ra.valid_from, ra.valid_until
       FROM role_assignments ra JOIN roles r
         ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.template_key = 'owner'
        AND ra.scope_type = 'tenant'
        AND ra.valid_from <= clock_timestamp()
        AND (ra.valid_until IS NULL OR ra.valid_until > clock_timestamp())`,
    [tenantId],
  );
  return rows;
}

/** The database wall clock in ms: valid_from/valid_until are stamped with it. */
async function dbNowMs(): Promise<number> {
  const { rows } = await owner.query<{ ms: number }>(
    "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms",
  );
  return rows[0]!.ms;
}

/** Direct insert of an Owner assignment that ends tomorrow (temporary). */
async function insertTemporaryOwner(
  tenantId: string,
  userId: string,
  assignedBy: string,
) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     SELECT $1, $2, r.id, 'tenant', now() - interval '1 minute',
            now() + interval '1 day', $3
       FROM roles r WHERE r.tenant_id = $1 AND r.template_key = 'owner'
     RETURNING id`,
    [tenantId, userId, assignedBy],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function assignmentRow(id: string) {
  const { rows } = await owner.query<{
    valid_until: Date | null;
    assigned_by: string;
  }>("SELECT valid_until, assigned_by FROM role_assignments WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

async function auditRows(tenantId: string, action: string, objectId?: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND ($3::text IS NULL OR event->>'objectId' = $3)
      ORDER BY id`,
    [tenantId, action, objectId ?? null],
  );
  return rows.map((row) => row.event);
}

async function outboxEvents(
  tenantId: string,
  name: string,
  aggregateId: string,
) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenantId, aggregateId, name],
  );
  return rows.map((row) => row.event);
}

const CHANGED = "tenant_owner.changed";

/**
 * legend-fmpgz: tenant_owner.changed events in the outbox. The event has its
 * own aggregate id, so it is looked up by tenant + name (+ destination).
 */
async function changedEvents(tenantId: string) {
  const { rows } = await owner.query<{
    destination: string;
    event: {
      name: string;
      actor: { type: string; id: string };
      payload: Record<string, unknown>;
    };
  }>(
    `SELECT destination, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
      ORDER BY created_at, id`,
    [tenantId, CHANGED],
  );
  return rows;
}

/**
 * Temporary DB trigger that makes appending tenant_owner.changed for ONE tenant
 * fail; other events and tenants are untouched. Always dropped in `finally`.
 */
async function withFailingChangedEnqueue<T>(
  tenantId: string,
  run: () => Promise<T>,
): Promise<T> {
  const fn = `fmpgz_fail_${randomBytes(4).toString("hex")}`;
  await owner.query(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.tenant_id = '${tenantId}'::uuid
          AND NEW.event->>'name' = '${CHANGED}' THEN
         RAISE EXCEPTION 'fmpgz forced enqueue failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  try {
    await owner.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON domain_event_outbox
         FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
    );
    return await run();
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON domain_event_outbox`);
    await owner.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
  }
}

function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

async function signedInUser(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, email, userId: session.body.user.id as string };
}

/** A signed-in tenant member holding a role (template or custom). */
async function tenantMember(tenantId: string, kind: "tenant_admin" | "custom") {
  const user = await signedInUser(`Anggota ${kind}`);
  let roleId: string;
  if (kind === "tenant_admin") {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'tenant_admin'",
      [tenantId],
    );
    roleId = rows[0]!.id;
  } else {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO roles
         (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, false, NULL, $3::jsonb, true, '["tenant"]'::jsonb)
       RETURNING id`,
      [
        tenantId,
        `Hampir owner ${randomBytes(4).toString("hex")}`,
        JSON.stringify(OWNER_CODES_WITHOUT_WRITEOFF),
      ],
    );
    roleId = rows[0]!.id;
  }
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, user.userId, roleId],
  );
  await verifySessionMfa(user.email);
  return user;
}

afterAll(async () => {
  // Owners appointed by invite are WhatsApp accounts (@wa.invalid) that grant
  // roles to others, so rows keep them as assigned_by. Remove those rows, or a
  // later file that deletes the accounts hits role_assignments_assigned_by_user_id_fk.
  await owner.query(
    `DELETE FROM role_assignments
      WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)
         OR assigned_by IN (SELECT id FROM "user" WHERE email LIKE $1)`,
    ["%@wa.invalid"],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await owner.end();
});

describe("legend-ktc4d platform Super Admin appoints and replaces a tenant Owner", () => {
  it("legend-ktc4d appoints the first Owner by invite, who then grants Owner through the tenant path", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);

    const response = await appoint(admin, tenant.tenantId, invite());
    expect(response.status).toBe(201);
    const data = response.body.data as {
      tenantId: string;
      assignmentId: string;
      userId: string;
      roleId: string;
      account: string;
      replacedAssignmentId: string | null;
    };
    expect(data).toMatchObject({
      tenantId: tenant.tenantId,
      account: "invited",
      replacedAssignmentId: null,
    });

    const owners = await activeOwners(tenant.tenantId);
    expect(owners.map((row) => row.id)).toEqual([data.assignmentId]);
    expect(owners[0]!.user_id).toBe(data.userId);
    expect((await assignmentRow(data.assignmentId))?.assigned_by).toBe(
      admin.userId,
    );

    // Normal tenant path (legend-7vsby): the new Owner grants Owner to another
    // account.
    const other = await signedInUser("Pemilik Kedua");
    // legend-495 G2: the second Owner already belongs to the tenant (here as
    // a Finance member), so the grant is not a stranger's first role.
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $3
         FROM roles WHERE tenant_id = $1 AND template_key = 'finance'`,
      [tenant.tenantId, other.userId, admin.userId],
    );
    const granted = await grantRoleAssignment(
      scopedContext(tenant.tenantId),
      grantRoleSchema.parse({
        userId: other.userId,
        roleId: data.roleId,
        scope: TENANT_SCOPE,
      }),
      {
        actorUserId: data.userId,
        reauthenticatedAt: new Date(),
        mfaVerified: true,
      },
    );
    expect(granted.userId).toBe(other.userId);
    expect(await activeOwners(tenant.tenantId)).toHaveLength(2);
  });

  it("legend-ktc4d appoints an existing member by userId", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    const response = await appoint(admin, tenant.tenantId, {
      userId: tenant.firstAdminUserId,
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      userId: tenant.firstAdminUserId,
      account: "member",
      replacedAssignmentId: null,
    });
    expect(
      (await activeOwners(tenant.tenantId)).map((row) => row.user_id),
    ).toEqual([tenant.firstAdminUserId]);
  });

  it("legend-ktc4d an invite for a WhatsApp number that already belongs to a member reuses that account", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    const response = await appoint(
      admin,
      tenant.tenantId,
      invite(tenant.firstAdminWhatsapp),
    );
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      userId: tenant.firstAdminUserId,
      account: "reused",
    });
  });

  it("legend-ktc4d replaces an Owner: the old assignment ends, the new one is active", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const first = await appoint(admin, tenant.tenantId, invite());
    expect(first.status).toBe(201);
    const oldId = first.body.data.assignmentId as string;

    const response = await replace(admin, tenant.tenantId, oldId, invite());
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      tenantId: tenant.tenantId,
      account: "invited",
      replacedAssignmentId: oldId,
    });
    const newId = response.body.data.assignmentId as string;
    expect(newId).not.toBe(oldId);

    const ended = await assignmentRow(oldId);
    expect(ended?.valid_until).not.toBeNull();
    expect(ended!.valid_until!.getTime()).toBeLessThanOrEqual(await dbNowMs());
    expect((await activeOwners(tenant.tenantId)).map((row) => row.id)).toEqual([
      newId,
    ]);
  });

  it("legend-ktc4d replace refuses the same user and an assignment that is not an Owner", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const first = await appoint(admin, tenant.tenantId, invite());
    const ownerId = first.body.data.assignmentId as string;
    const ownerUserId = first.body.data.userId as string;

    // Replacing an Owner with the same account is refused (422).
    const same = await replace(admin, tenant.tenantId, ownerId, {
      userId: ownerUserId,
    });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe("VALIDATION_ERROR");

    // The tenant_admin assignment is not an Owner assignment (404).
    const notOwner = await replace(
      admin,
      tenant.tenantId,
      tenant.firstAdminAssignmentId,
      invite(),
    );
    expect(notOwner.status).toBe(404);
    expect(notOwner.body.error.code).toBe("NOT_FOUND");

    // An unknown assignment id is a 404 as well.
    const unknown = await replace(
      admin,
      tenant.tenantId,
      randomUUID(),
      invite(),
    );
    expect(unknown.status).toBe(404);

    // Nothing changed: the original Owner is still the only active Owner.
    expect((await activeOwners(tenant.tenantId)).map((row) => row.id)).toEqual([
      ownerId,
    ]);
  });

  it("legend-ktc4d replace refuses an assignment that already ended (422)", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const first = await appoint(admin, tenant.tenantId, invite());
    const oldId = first.body.data.assignmentId as string;
    expect(
      (await replace(admin, tenant.tenantId, oldId, invite())).status,
    ).toBe(201);

    const again = await replace(admin, tenant.tenantId, oldId, invite());
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("VALIDATION_ERROR");
    expect(await activeOwners(tenant.tenantId)).toHaveLength(1);
  });

  it("legend-ktc4d refuses to appoint an account that is already an active Owner (409)", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    expect(
      (
        await appoint(admin, tenant.tenantId, {
          userId: tenant.firstAdminUserId,
        })
      ).status,
    ).toBe(201);

    const again = await appoint(admin, tenant.tenantId, {
      userId: tenant.firstAdminUserId,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");
    expect(await activeOwners(tenant.tenantId)).toHaveLength(1);
  });

  it("legend-ktc4d answers 403 to a tenant admin or custom-role user who is not a platform admin", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    for (const kind of ["tenant_admin", "custom"] as const) {
      const member = await tenantMember(tenant.tenantId, kind);
      const response = await member.client
        .post(ownersPath(tenant.tenantId))
        .set(originHeader)
        .send({ account: invite(), reason: REASON, mfaCode: "123456" });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
  });

  it("legend-ktc4d answers 401 without a session", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const response = await agent(app)
      .post(ownersPath(tenant.tenantId))
      .set(originHeader)
      .send({ account: invite(), reason: REASON, mfaCode: "123456" });
    expect(response.status).toBe(401);
  });

  it("legend-ktc4d answers 403 to a platform admin whose session has no verified second factor", async () => {
    const setup = await platformAdmin();
    const tenant = await newTenant(setup);

    // Registry member without any enrolled factor or verified session.
    const client = agent(app);
    await signUp(client, "Admin Tanpa MFA");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      userId,
    ]);
    platformAdminIds.push(userId);

    const response = await client
      .post(ownersPath(tenant.tenantId))
      .set(originHeader)
      .send({ account: invite(), reason: REASON, mfaCode: "123456" });
    expect(response.status).toBe(403);
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
  });

  it("legend-ktc4d answers 403 and audits tenant_owner.denied when the mfaCode is missing or wrong", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    const missing = await appoint(admin, tenant.tenantId, invite(), {
      mfaCode: undefined,
    });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("FORBIDDEN");

    const wrong = await appoint(admin, tenant.tenantId, invite(), {
      mfaCode: admin.wrongCode(),
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe("FORBIDDEN");

    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
    const denied = await auditRows(tenant.tenantId, "tenant_owner.denied");
    expect(denied).toHaveLength(2);
    for (const event of denied) {
      expect(event.actorId).toBe(admin.userId);
      expect(event.reason).toBe(REASON);
      expect(JSON.stringify(event)).toContain("mfa_not_verified");
    }
  });

  it("legend-ktc4d answers 403 on replace when the mfaCode is wrong and keeps the current Owner", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const first = await appoint(admin, tenant.tenantId, invite());
    const oldId = first.body.data.assignmentId as string;

    const response = await replace(admin, tenant.tenantId, oldId, invite(), {
      mfaCode: admin.wrongCode(),
    });
    expect(response.status).toBe(403);
    expect((await activeOwners(tenant.tenantId)).map((row) => row.id)).toEqual([
      oldId,
    ]);
  });

  it("legend-ktc4d replaces a permanent Owner with a temporary Owner: the account gets a NEW permanent row", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const first = await appoint(admin, tenant.tenantId, invite());
    expect(first.status).toBe(201);
    const ownerAId = first.body.data.assignmentId as string;
    const b = await signedInUser("Pemilik Sementara");
    const tempId = await insertTemporaryOwner(
      tenant.tenantId,
      b.userId,
      admin.userId,
    );

    const response = await replace(admin, tenant.tenantId, ownerAId, {
      userId: b.userId,
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      userId: b.userId,
      replacedAssignmentId: ownerAId,
    });
    const newId = response.body.data.assignmentId as string;
    expect(newId).not.toBe(tempId);

    const created = await assignmentRow(newId);
    expect(created?.valid_until).toBeNull();
    const ended = await assignmentRow(ownerAId);
    expect(ended?.valid_until).not.toBeNull();
    expect(ended!.valid_until!.getTime()).toBeLessThanOrEqual(await dbNowMs());

    // The tenant keeps a permanent Owner, and it is B's new row.
    const permanent = (await activeOwners(tenant.tenantId)).filter(
      (row) => row.valid_until === null,
    );
    expect(permanent.map((row) => row.id)).toEqual([newId]);
    expect(permanent[0]!.user_id).toBe(b.userId);
  });

  it("legend-ktc4d appoints an account that is only a temporary Owner as a new permanent Owner (201, not 409)", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const b = await signedInUser("Pemilik Sementara");
    const tempId = await insertTemporaryOwner(
      tenant.tenantId,
      b.userId,
      admin.userId,
    );

    const response = await appoint(admin, tenant.tenantId, {
      userId: b.userId,
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      userId: b.userId,
      replacedAssignmentId: null,
    });
    const newId = response.body.data.assignmentId as string;
    expect(newId).not.toBe(tempId);
    expect((await assignmentRow(newId))?.valid_until).toBeNull();
    expect(
      (await activeOwners(tenant.tenantId)).filter(
        (row) => row.valid_until === null,
      ),
    ).toHaveLength(1);
  });

  it("legend-ktc4d answers 403 for an impersonated session", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    // Mark the actor's own session as impersonated (Better Auth admin plugin).
    const { rowCount } = await owner.query(
      `UPDATE "session" SET impersonated_by = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [admin.userId, tenant.firstAdminUserId],
    );
    expect(rowCount).toBeGreaterThan(0);

    const response = await appoint(admin, tenant.tenantId, invite());
    expect(response.status).toBe(403);
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);

    // The support guard refuses first (SUPPORT_ACCESS_REQUIRED), so the
    // service never runs: no tenant_owner.denied, but the platform route
    // writes one platform.access.denied row on the tenant (the impersonator
    // is a tenant_admin there, so the tie rule lets the row through).
    expect(
      await auditRows(tenant.tenantId, "tenant_owner.denied"),
    ).toHaveLength(0);
    const denied = await auditRows(tenant.tenantId, "platform.access.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      // actor = the impersonator; `impersonatedUserId` = the session user.
      actorId: tenant.firstAdminUserId,
      maskedChanges: {
        after: {
          cause: "impersonated_session",
          code: "SUPPORT_ACCESS_REQUIRED",
          impersonatedBy: tenant.firstAdminUserId,
          impersonatedUserId: admin.userId,
          method: "POST",
          route: ownersPath(tenant.tenantId),
        },
      },
    });
  });

  it("legend-ktc4d refuses a direct service call with impersonatedBy set (403 FORBIDDEN) and audits tenant_owner.denied", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    // Same body the appoint helper sends (account, reason, mfaCode).
    const input = (await payload(admin, invite())) as AssignTenantOwnerInput;

    await expect(
      assignTenantOwner({
        tenantId: tenant.tenantId,
        actorUserId: admin.userId,
        impersonatedBy: tenant.firstAdminUserId,
        mfaVerifiedAt: new Date().toISOString(),
        input,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
    const denied = await auditRows(tenant.tenantId, "tenant_owner.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actorId: admin.userId,
      maskedChanges: {
        after: {
          cause: "impersonated_session",
          impersonatedBy: tenant.firstAdminUserId,
        },
      },
    });
  });

  it("legend-ktc4d refuses self-appointment (403)", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    // Make the Super Admin a member of the tenant so the account resolves.
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'tenant_admin'",
      [tenant.tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [tenant.tenantId, admin.userId, rows[0]!.id],
    );

    const response = await appoint(admin, tenant.tenantId, {
      userId: admin.userId,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
  });

  it("legend-ktc4d refuses to appoint another platform Super Admin who is a tenant member (403, no Owner row)", async () => {
    // Assumption: a target account listed in platform_admins is refused the
    // same way as self-appointment, even when it is a regular tenant member.
    const admin = await platformAdmin();
    const otherAdmin = await platformAdmin("Super Admin Lain");
    const tenant = await newTenant(admin);
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'tenant_admin'",
      [tenant.tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [tenant.tenantId, otherAdmin.userId, rows[0]!.id],
    );

    const response = await appoint(admin, tenant.tenantId, {
      userId: otherAdmin.userId,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
  });

  it("legend-ktc4d answers 422 for an empty or blank reason", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    for (const reason of ["", "   ", "x".repeat(501)]) {
      const response = await appoint(admin, tenant.tenantId, invite(), {
        reason,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    }
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
  });

  it("legend-ktc4d answers 422 when the userId is not a member of the tenant", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const stranger = await signedInUser("Bukan Anggota");

    const response = await appoint(admin, tenant.tenantId, {
      userId: stranger.userId,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await activeOwners(tenant.tenantId)).toHaveLength(0);
  });

  it("legend-ktc4d answers 404 for an unknown tenant", async () => {
    const admin = await platformAdmin();
    const response = await appoint(admin, randomUUID(), invite());
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("legend-ktc4d audits the appointment, the replacement and the ended assignment, and queues the event", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    const first = await appoint(admin, tenant.tenantId, invite());
    expect(first.status).toBe(201);
    const firstId = first.body.data.assignmentId as string;

    const granted = await auditRows(
      tenant.tenantId,
      "role_assignment.granted",
      firstId,
    );
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ actorId: admin.userId, reason: REASON });
    const assigned = await auditRows(
      tenant.tenantId,
      "tenant_owner.assigned",
      firstId,
    );
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      actorId: admin.userId,
      objectType: "role_assignment",
      reason: REASON,
    });
    expect(
      (await outboxEvents(tenant.tenantId, "role_assignment.granted", firstId))
        .length,
    ).toBeGreaterThanOrEqual(1);

    const second = await replace(admin, tenant.tenantId, firstId, invite());
    expect(second.status).toBe(201);
    const secondId = second.body.data.assignmentId as string;

    const replaced = await auditRows(
      tenant.tenantId,
      "tenant_owner.replaced",
      secondId,
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      actorId: admin.userId,
      reason: REASON,
    });
    expect(
      await auditRows(tenant.tenantId, "role_assignment.granted", secondId),
    ).toHaveLength(1);
    const ended = await auditRows(
      tenant.tenantId,
      "role_assignment.ended",
      firstId,
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ actorId: admin.userId, reason: REASON });
    expect(
      (await outboxEvents(tenant.tenantId, "role_assignment.granted", secondId))
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await outboxEvents(tenant.tenantId, "role_assignment.ended", firstId))
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("legend-fmpgz appointing and replacing an Owner each queue one tenant_owner.changed notification event", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    // Nothing queued before any appointment.
    expect(await changedEvents(tenant.tenantId)).toHaveLength(0);

    const first = await appoint(admin, tenant.tenantId, invite());
    expect(first.status).toBe(201);
    const firstId = first.body.data.assignmentId as string;
    const firstUserId = first.body.data.userId as string;

    const afterAssign = await changedEvents(tenant.tenantId);
    expect(afterAssign).toHaveLength(1);
    expect(afterAssign[0]!.destination).toBe("notification");
    expect(afterAssign[0]!.event.name).toBe(CHANGED);
    expect(afterAssign[0]!.event.payload).toMatchObject({
      kind: "assigned",
      actorUserId: admin.userId,
      reason: REASON,
      newAssignmentId: firstId,
      replacedAssignmentId: null,
    });

    const second = await replace(admin, tenant.tenantId, firstId, invite());
    expect(second.status).toBe(201);
    const secondId = second.body.data.assignmentId as string;
    const secondUserId = second.body.data.userId as string;

    const afterReplace = await changedEvents(tenant.tenantId);
    expect(afterReplace).toHaveLength(2);
    const replacedEvent = afterReplace.find(
      (row) => row.event.payload.kind === "replaced",
    )!;
    expect(replacedEvent.destination).toBe("notification");
    expect(replacedEvent.event.payload).toMatchObject({
      kind: "replaced",
      actorUserId: admin.userId,
      reason: REASON,
      newAssignmentId: secondId,
      replacedAssignmentId: firstId,
    });

    // The payload names assignments, never recipients: the notification
    // consumer resolves who to tell. The only user id is the acting admin.
    for (const row of afterReplace) {
      expect(Object.keys(row.event.payload).sort()).toEqual([
        "actorUserId",
        "changedAt",
        "kind",
        "newAssignmentId",
        "reason",
        "replacedAssignmentId",
      ]);
      const serialized = JSON.stringify(row.event);
      expect(serialized).not.toContain(firstUserId);
      expect(serialized).not.toContain(secondUserId);
    }
  });

  it("legend-fmpgz a failed notification enqueue keeps the appointment and the replacement, and audits tenant_owner.notify_failed", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    // Appointment with a failing enqueue.
    const assigned = await withFailingChangedEnqueue(tenant.tenantId, () =>
      appoint(admin, tenant.tenantId, invite()),
    );
    expect(assigned.status).toBe(201);
    const firstId = assigned.body.data.assignmentId as string;
    expect((await activeOwners(tenant.tenantId)).map((row) => row.id)).toEqual([
      firstId,
    ]);
    expect(await changedEvents(tenant.tenantId)).toHaveLength(0);
    const failedAssign = await auditRows(
      tenant.tenantId,
      "tenant_owner.notify_failed",
    );
    expect(failedAssign).toHaveLength(1);
    expect(failedAssign[0]).toMatchObject({
      actorId: admin.userId,
      objectId: firstId,
      reason: REASON,
    });
    // The normal audit trail of the appointment is still written.
    expect(
      await auditRows(tenant.tenantId, "tenant_owner.assigned", firstId),
    ).toHaveLength(1);

    // Replacement with a failing enqueue.
    const replaced = await withFailingChangedEnqueue(tenant.tenantId, () =>
      replace(admin, tenant.tenantId, firstId, invite()),
    );
    expect(replaced.status).toBe(201);
    const secondId = replaced.body.data.assignmentId as string;
    expect((await activeOwners(tenant.tenantId)).map((row) => row.id)).toEqual([
      secondId,
    ]);
    const ended = await assignmentRow(firstId);
    expect(ended?.valid_until).not.toBeNull();
    expect(ended!.valid_until!.getTime()).toBeLessThanOrEqual(await dbNowMs());
    expect(await changedEvents(tenant.tenantId)).toHaveLength(0);
    const failedReplace = await auditRows(
      tenant.tenantId,
      "tenant_owner.notify_failed",
      secondId,
    );
    expect(failedReplace).toHaveLength(1);
    expect(
      await auditRows(tenant.tenantId, "tenant_owner.replaced", secondId),
    ).toHaveLength(1);

    // With the trigger gone, notifications flow again and no further failure
    // is audited.
    const third = await replace(admin, tenant.tenantId, secondId, invite());
    expect(third.status).toBe(201);
    expect(await changedEvents(tenant.tenantId)).toHaveLength(1);
    expect(
      await auditRows(tenant.tenantId, "tenant_owner.notify_failed"),
    ).toHaveLength(2);
  });

  it("legend-fmpgz refused requests (403, 409, 422, 404) queue no tenant_owner.changed event", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const first = await appoint(admin, tenant.tenantId, invite());
    expect(first.status).toBe(201);
    const firstId = first.body.data.assignmentId as string;
    const firstUserId = first.body.data.userId as string;
    // Only the successful appointment above queued an event.
    expect(await changedEvents(tenant.tenantId)).toHaveLength(1);

    // 403: wrong MFA code, on appoint and on replace.
    expect(
      (
        await appoint(admin, tenant.tenantId, invite(), {
          mfaCode: admin.wrongCode(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await replace(admin, tenant.tenantId, firstId, invite(), {
          mfaCode: admin.wrongCode(),
        })
      ).status,
    ).toBe(403);
    // 403: a tenant admin who is not a platform admin.
    const member = await tenantMember(tenant.tenantId, "tenant_admin");
    const forbidden = await member.client
      .post(ownersPath(tenant.tenantId))
      .set(originHeader)
      .send({ account: invite(), reason: REASON, mfaCode: "123456" });
    expect(forbidden.status).toBe(403);
    // 409: the account is already an active Owner.
    expect(
      (await appoint(admin, tenant.tenantId, { userId: firstUserId })).status,
    ).toBe(409);
    // 422: replace with the same account; empty reason.
    expect(
      (await replace(admin, tenant.tenantId, firstId, { userId: firstUserId }))
        .status,
    ).toBe(422);
    expect(
      (await appoint(admin, tenant.tenantId, invite(), { reason: "" })).status,
    ).toBe(422);
    // 404: unknown assignment.
    expect(
      (await replace(admin, tenant.tenantId, randomUUID(), invite())).status,
    ).toBe(404);

    // Still exactly the one event of the first appointment; no failure audit.
    expect(await changedEvents(tenant.tenantId)).toHaveLength(1);
    expect(
      await auditRows(tenant.tenantId, "tenant_owner.notify_failed"),
    ).toHaveLength(0);
    expect((await activeOwners(tenant.tenantId)).map((row) => row.id)).toEqual([
      firstId,
    ]);
  });
});
