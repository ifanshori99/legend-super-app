// legend-hzdy5 (tier K auth). The platform path that appoints or replaces a
// tenant Owner (legend-ktc4d) must stamp the new Owner's valid_from and the
// replaced Owner's valid_until with the DATABASE clock (clock_timestamp()), not
// the application clock, so Owner order matches what the tenant access path
// (grant/end) records. Expected behavior comes from PRD v1.7 §3.7 / TEN-03/04.
// Assumptions:
// - Appointing and replacing without any date input starts the new Owner now
//   (valid_from) and ends the replaced Owner now (valid_until).
// - Proof that the DB clock is used: the application `Date` is faked 60 s into
//   the past while the service runs. Code that stamps with `new Date()` writes a
//   time 60 s before the DB bracket [before call, after call] and fails. The TOTP
//   code and mfaVerifiedAt handed to the service are taken from that same faked
//   clock, so the second-factor check passes whichever clock the service reads.
// - The lock key of this path is not defined in the brief, so no lock barrier is
//   used here (the access path has one: access-role-assignment-db-clock.test.ts).
//   Comparisons run in SQL on DB timestamps, so Node/DB clock drift is ignored.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assignTenantOwnerInputSchema,
  replaceTenantOwnerInputSchema,
} from "@starter/shared/platform";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import {
  assignTenantOwner,
  replaceTenantOwner,
} from "../services/platform-tenant-owner.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const platformAdminIds: string[] = [];

const REASON =
  "Pemilik lama mengundurkan diri, pemilik baru ditunjuk Super Admin.";
const APP_CLOCK_SKEW_MS = 60_000;

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

/** Platform Super Admin with a real enrolled, verified TOTP factor. */
async function platformAdmin() {
  const client = agent(app);
  await signUp(client, "Super Admin Clock");
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
    /** A valid, unused TOTP code for the app clock as it is right now. */
    code: async () => {
      await owner.query(
        `UPDATE mfa_factors
            SET last_used_step = NULL, failed_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [factorId],
      );
      return totpCode(secretBase32, totpStep(new Date()));
    },
  };
}

/** A tenant with seeded templates and one tenant_admin (the first admin). */
async function newTenant(admin: Awaited<ReturnType<typeof platformAdmin>>) {
  const created = await admin.client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `owner-clock-${randomBytes(4).toString("hex")}`,
      name: "Uji Jam DB Owner",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: randomWhatsapp(),
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;
  const { rows } = await owner.query<{ user_id: string }>(
    `SELECT ra.user_id FROM role_assignments ra JOIN roles r
       ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.template_key = 'tenant_admin'
        AND ra.scope_type = 'tenant'`,
    [tenantId],
  );
  expect(rows).toHaveLength(1);
  return { tenantId, firstAdminUserId: rows[0]!.user_id };
}

/** A second tenant member (tenant_admin) to replace the first Owner with. */
async function secondMember(tenantId: string, assignedBy: string) {
  const client = agent(app);
  await signUp(client, "Anggota Kedua");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, r.id, 'tenant', now() - interval '10 minutes', $3
       FROM roles r WHERE r.tenant_id = $1 AND r.template_key = 'tenant_admin'`,
    [tenantId, userId, assignedBy],
  );
  return userId;
}

async function dbClock(): Promise<string> {
  const { rows } = await owner.query<{ t: string }>(
    "SELECT clock_timestamp()::text AS t",
  );
  return rows[0]!.t;
}

afterAll(async () => {
  vi.useRealTimers();
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

describe("legend-hzdy5 platform Owner appoint and replace use the DB clock", () => {
  it("legend-hzdy5 appointing an Owner stamps valid_from with the DB clock", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    const before = await dbClock();
    let appointed;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() - APP_CLOCK_SKEW_MS));
      appointed = await assignTenantOwner({
        tenantId: tenant.tenantId,
        actorUserId: admin.userId,
        impersonatedBy: null,
        mfaVerifiedAt: new Date().toISOString(),
        input: assignTenantOwnerInputSchema.parse({
          account: { userId: tenant.firstAdminUserId },
          reason: REASON,
          mfaCode: await admin.code(),
        }),
      });
    } finally {
      vi.useRealTimers();
    }
    const after = await dbClock();

    const { rows } = await owner.query<{ inside: boolean }>(
      `SELECT (valid_from >= date_trunc('milliseconds', $2::timestamptz) AND valid_from <= $3::timestamptz) AS inside
       FROM role_assignments WHERE id = $1`,
      [appointed.assignmentId, before, after],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inside).toBe(true);
  }, 30_000);

  it("legend-hzdy5 replacing an Owner stamps the old valid_until and the new valid_from with the DB clock", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    const replacement = await secondMember(tenant.tenantId, admin.userId);

    const before = await dbClock();
    let first;
    let second;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() - APP_CLOCK_SKEW_MS));
      first = await assignTenantOwner({
        tenantId: tenant.tenantId,
        actorUserId: admin.userId,
        impersonatedBy: null,
        mfaVerifiedAt: new Date().toISOString(),
        input: assignTenantOwnerInputSchema.parse({
          account: { userId: tenant.firstAdminUserId },
          reason: REASON,
          mfaCode: await admin.code(),
        }),
      });
      second = await replaceTenantOwner({
        tenantId: tenant.tenantId,
        actorUserId: admin.userId,
        impersonatedBy: null,
        mfaVerifiedAt: new Date().toISOString(),
        input: replaceTenantOwnerInputSchema.parse({
          account: { userId: replacement },
          reason: REASON,
          mfaCode: await admin.code(),
        }),
        replacedAssignmentId: first.assignmentId,
      });
    } finally {
      vi.useRealTimers();
    }
    const after = await dbClock();

    expect(second.replacedAssignmentId).toBe(first.assignmentId);
    const { rows } = await owner.query<{
      id: string;
      from_inside: boolean;
      until_inside: boolean | null;
    }>(
      `SELECT id,
              (valid_from >= date_trunc('milliseconds', $2::timestamptz) AND valid_from <= $3::timestamptz) AS from_inside,
              CASE WHEN valid_until IS NULL THEN NULL
                   ELSE (valid_until >= date_trunc('milliseconds', $2::timestamptz) AND valid_until <= $3::timestamptz)
              END AS until_inside
       FROM role_assignments WHERE id::text = ANY($1::text[])`,
      [[first.assignmentId, second.assignmentId], before, after],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    // The replaced Owner is ended now, by the DB clock.
    expect(byId.get(first.assignmentId)?.until_inside).toBe(true);
    // The new Owner starts now, by the DB clock, and stays open-ended.
    expect(byId.get(second.assignmentId)?.from_inside).toBe(true);
    expect(byId.get(second.assignmentId)?.until_inside).toBeNull();
  }, 30_000);

  // Assumptions (deviation from the brief wording, see the report):
  // - A ban is judged by the DB clock. With the app clock BEHIND the DB clock, a
  //   ban whose banExpires lies between the two is already over by the DB clock,
  //   so DB-clock code would allow the appointment and no 422 could be expected.
  //   To get a 422 that only the DB clock can produce, the app Date is faked 60 s
  //   AHEAD of the DB clock: banExpires = DB clock + 30 s looks over to the app
  //   clock but is still running by the DB clock. The appointment is refused 422
  //   and creates no Owner assignment. The skewed clock is derived from the DB
  //   clock, so Node/container drift cannot change the outcome.
  it("legend-hzdy5 appointing an account whose ban is still running by the DB clock is refused 422 although the app clock says it is over", async () => {
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);
    await owner.query(
      `UPDATE "user"
          SET banned = true, ban_expires = clock_timestamp() + interval '30 seconds'
        WHERE id = $1`,
      [tenant.firstAdminUserId],
    );

    const { rows: clock } = await owner.query<{ ms: number }>(
      "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms",
    );
    let outcome: { ok: true } | { ok: false; reason: unknown };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(clock[0]!.ms + APP_CLOCK_SKEW_MS));
      outcome = await assignTenantOwner({
        tenantId: tenant.tenantId,
        actorUserId: admin.userId,
        impersonatedBy: null,
        mfaVerifiedAt: new Date().toISOString(),
        input: assignTenantOwnerInputSchema.parse({
          account: { userId: tenant.firstAdminUserId },
          reason: REASON,
          mfaCode: await admin.code(),
        }),
      }).then(
        () => ({ ok: true as const }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { status?: number }).status).toBe(422);
    }
    const { rows } = await owner.query(
      `SELECT 1 FROM role_assignments ra JOIN roles r
         ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1 AND ra.user_id = $2 AND r.template_key = 'owner'`,
      [tenant.tenantId, tenant.firstAdminUserId],
    );
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("legend-hzdy5 the same unfaked clock still appoints and the Owner is active at the DB clock", async () => {
    // Control for the two tests above: no clock skew, so a failure there is the
    // clock source and not the setup.
    const admin = await platformAdmin();
    const tenant = await newTenant(admin);

    const appointed = await assignTenantOwner({
      tenantId: tenant.tenantId,
      actorUserId: admin.userId,
      impersonatedBy: null,
      mfaVerifiedAt: new Date().toISOString(),
      input: assignTenantOwnerInputSchema.parse({
        account: { userId: tenant.firstAdminUserId },
        reason: REASON,
        mfaCode: await admin.code(),
      }),
    });

    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE id = $1 AND valid_until IS NULL AND valid_from <= clock_timestamp()`,
      [appointed.assignmentId],
    );
    expect(rows).toHaveLength(1);
  }, 30_000);
});
