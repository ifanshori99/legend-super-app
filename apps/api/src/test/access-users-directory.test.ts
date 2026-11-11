// Staff directory (bead legend-i6ff): GET /api/access/users.
// Written from the brief (docs/briefs/sub-approvals-rbac-bundle.md section B)
// and the tier-K security rules, not from the implementation. HTTP tests run
// the real Express app, Better Auth and PostgreSQL, like
// platform-access-api.test.ts.
//
// Assumptions (the brief leaves them open):
//  - the directory lists a banned user or a user whose only assignment is
//    expired/not yet valid, with status "inactive" (it is not hidden);
//  - invalid query values answer 422, the house pattern for list endpoints;
//  - a custom role without access.role.view stands in for "no permission".
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  seededTenantId,
  staffOfIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";
import { agent, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const USERS = "/api/access/users";
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
let otherTenant: IsolatedTenant | null = null;

const unique = () => randomBytes(4).toString("hex");

type Row = {
  userId: string;
  displayName: string;
  kind: string;
  status: string;
};
type Staff = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [seededTenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

/** Tenant-wide custom role that does NOT hold access.role.view. */
async function roleWithoutDirectoryView(): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      seededTenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(["floor.table.view"]),
      JSON.stringify(["tenant"]),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

/** The isolated tenant's custom role has no access.role.view; add one. */
async function allowDirectoryView(
  tenant: IsolatedTenant,
  userId: string,
): Promise<void> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Lihat Direktori', false, NULL, $3::jsonb, false, '["tenant"]'::jsonb)`,
    [roleId, tenant.tenantId, JSON.stringify(["access.role.view"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
}

/** A real account, signed in with a verified second factor. */
async function account(name: string): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await verifySessionMfa(email);
  return { client, userId, email };
}

type Window = { from?: string; until?: string | null };

/** Grant a role in the seeded tenant. Window values are SQL intervals. */
async function grant(
  userId: string,
  roleId: string,
  window: Window = {},
): Promise<void> {
  const from = window.from ?? "now() - interval '1 minute'";
  const until = window.until ?? null;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, ${from}, ${until ?? "NULL"}, $2)`,
    [seededTenantId, userId, roleId],
  );
}

/** Staff with a current tenant-wide role of the given template. */
async function staff(
  name: string,
  template = "cashier",
  window: Window = {},
): Promise<Staff> {
  const user = await account(name);
  await grant(user.userId, await roleIdOf(template), window);
  return user;
}

/** An owner (holds access.role.view) to call the directory with. */
const viewer = () => staff(`Pemilik ${unique()}`, "owner");

async function list(client: Staff["client"], query = ""): Promise<Row[]> {
  const res = await client.get(`${USERS}${query}`);
  expect(res.status).toBe(200);
  return res.body.data as Row[];
}

const idsOf = (rows: Row[]) => rows.map((row) => row.userId);

beforeAll(() => {
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, createdRoleIds],
    );
  if (otherTenant) await dropIsolatedTenant(otherTenant);
  await owner.end();
});

describe("legend-i6ff GET /api/access/users access control", () => {
  it("legend-i6ff an anonymous caller gets 401", async () => {
    expect((await agent(app).get(USERS)).status).toBe(401);
  });

  it("legend-i6ff a staff member without access.role.view gets 403", async () => {
    const limited = await account("Staf tanpa izin");
    await grant(limited.userId, await roleWithoutDirectoryView());
    const res = await limited.client.get(USERS);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it("legend-i6ff access.role.view held at only one outlet gets 403 (the directory is tenant-wide)", async () => {
    // Assumption: the directory lists tenant staff, so the permission must be
    // held tenant-wide; an outlet-scoped grant does not qualify.
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles
         (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, '["outlet"]'::jsonb)`,
      [
        roleId,
        seededTenantId,
        `Lihat outlet ${roleId.slice(0, 8)}`,
        JSON.stringify(["access.role.view"]),
      ],
    );
    createdRoleIds.push(roleId);
    const outletViewer = await account("Peninjau satu outlet");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [
        seededTenantId,
        outletViewer.userId,
        roleId,
        cafeLegendAccessFixtures.outletIds.bandung,
      ],
    );
    const res = await outletViewer.client.get(USERS);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it("legend-i6ff a signed-in user with no assignment in the tenant gets 403", async () => {
    const outsider = await account("Bukan staf");
    expect((await outsider.client.get(USERS)).status).toBe(403);
  });

  it("legend-i6ff a holder of access.role.view (owner) gets 200 with a cursor page", async () => {
    const admin = await viewer();
    const res = await admin.client.get(`${USERS}?limit=5`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.limit).toBe(5);
    expect(res.body.data.length).toBeLessThanOrEqual(5);
    // The caller is staff of this tenant, so the directory is never empty.
    expect(idsOf(res.body.data).length).toBeGreaterThan(0);
  });

  it("legend-i6ff invalid paging or q values answer 422", async () => {
    const admin = await viewer();
    expect((await admin.client.get(`${USERS}?limit=0`)).status).toBe(422);
    expect((await admin.client.get(`${USERS}?limit=101`)).status).toBe(422);
    expect(
      (await admin.client.get(`${USERS}?q=${"a".repeat(101)}`)).status,
    ).toBe(422);
  });
});

describe("legend-i6ff GET /api/access/users response shape and privacy", () => {
  it("legend-i6ff each row has exactly userId, displayName, kind and status", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const member = await staff(`${token} Bentuk`);
    const rows = await list(admin.client, `?q=${token}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual([
      "displayName",
      "kind",
      "status",
      "userId",
    ]);
    expect(row.userId).toBe(member.userId);
    expect(row.displayName).toBe(`${token} Bentuk`);
    expect(row.kind).toBe("staff");
    expect(row.status).toBe("active");
  });

  it("legend-i6ff the raw response never carries email or other personal data", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const member = await staff(`${token} Privasi`);
    const res = await admin.client.get(`${USERS}?q=${token}`);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(member.email);
    expect(raw).not.toContain("@example.com");
    for (const field of ["email", "phone", "image", "pin", "password"]) {
      expect(raw.toLowerCase()).not.toContain(`"${field}`);
    }
  });

  it("legend-i6ff lists only staff: a signed-up user without an assignment is absent", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const member = await staff(`${token} Staf`);
    const outsider = await account(`${token} Pelanggan`);
    const ids = idsOf(await list(admin.client, `?q=${token}`));
    expect(ids).toContain(member.userId);
    expect(ids).not.toContain(outsider.userId);
  });

  it("legend-i6ff a user with several assignments is listed once", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const member = await staff(`${token} Ganda`, "cashier");
    await grant(member.userId, await roleIdOf("waiter"));
    const rows = await list(admin.client, `?q=${token}`);
    expect(idsOf(rows).filter((id) => id === member.userId)).toHaveLength(1);
  });
});

describe("legend-i6ff GET /api/access/users tenant isolation", () => {
  it("legend-i6ff a user of another tenant is never listed, and each tenant sees only its own staff", async () => {
    const token = `Zq${unique()}`;
    otherTenant ??= await createIsolatedTenant(`dir-${unique()}`);
    const admin = await viewer();
    const mine = await staff(`${token} Milik Sendiri`);

    const theirs = await staffOfIsolatedTenant(app, otherTenant);
    await allowDirectoryView(otherTenant, theirs.userId);
    // Give the other tenant's user the same searchable name token.
    await owner.query('UPDATE "user" SET name = $2 WHERE id = $1', [
      theirs.userId,
      `${token} Tenant Lain`,
    ]);
    createdUserIds.push(theirs.userId);
    await verifySessionMfa(theirs.email);

    const seen = await list(admin.client, `?q=${token}&limit=100`);
    expect(idsOf(seen)).toContain(mine.userId);
    expect(idsOf(seen)).not.toContain(theirs.userId);
    expect(JSON.stringify(seen)).not.toContain("Tenant Lain");

    // The other tenant's own directory shows its user and none of ours.
    // The active tenant is resolved from the request host (floor-api.test.ts
    // does the same); without it the call lands in the seeded tenant.
    const theirView = await theirs.client
      .get(`${USERS}?q=${token}&limit=100`)
      .set({ Host: otherTenant.hostname });
    expect(theirView.status).toBe(200);
    const theirIds = idsOf(theirView.body.data as Row[]);
    expect(theirIds).toContain(theirs.userId);
    expect(theirIds).not.toContain(mine.userId);
    expect(theirIds).not.toContain(admin.userId);
  });

  it("legend-i6ff a tenantId in the query never widens the result to another tenant", async () => {
    const token = `Zq${unique()}`;
    otherTenant ??= await createIsolatedTenant(`dir-${unique()}`);
    const admin = await viewer();
    const theirs = await staffOfIsolatedTenant(app, otherTenant);
    await owner.query('UPDATE "user" SET name = $2 WHERE id = $1', [
      theirs.userId,
      `${token} Tenant Lain`,
    ]);
    createdUserIds.push(theirs.userId);

    const res = await admin.client.get(
      `${USERS}?q=${token}&tenantId=${otherTenant.tenantId}`,
    );
    // Rejected as an unknown key or ignored: either way no foreign user.
    expect([200, 400, 422]).toContain(res.status);
    if (res.status === 200)
      expect(idsOf(res.body.data as Row[])).not.toContain(theirs.userId);
  });

  it("legend-i6ff a user whose assignment lives only in another tenant is absent from this one", async () => {
    const token = `Zq${unique()}`;
    otherTenant ??= await createIsolatedTenant(`dir-${unique()}`);
    const admin = await viewer();
    const theirs = await staffOfIsolatedTenant(app, otherTenant);
    createdUserIds.push(theirs.userId);
    await owner.query('UPDATE "user" SET name = $2 WHERE id = $1', [
      theirs.userId,
      `${token} Hanya Tenant Lain`,
    ]);
    expect(await list(admin.client, `?q=${token}`)).toEqual([]);
  });
});

describe("legend-i6ff GET /api/access/users status", () => {
  it("legend-i6ff a banned user is inactive while an active colleague stays active", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const banned = await staff(`${token} Dilarang`);
    const active = await staff(`${token} Aktif`);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      banned.userId,
    ]);
    const byId = new Map(
      (await list(admin.client, `?q=${token}`)).map((r) => [r.userId, r]),
    );
    expect(byId.get(banned.userId)?.status).toBe("inactive");
    expect(byId.get(active.userId)?.status).toBe("active");
  });

  it("legend-i6ff a user whose only assignment expired is inactive", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const expired = await staff(`${token} Kedaluwarsa`, "cashier", {
      from: "now() - interval '2 hours'",
      until: "now() - interval '1 minute'",
    });
    const rows = await list(admin.client, `?q=${token}`);
    expect(rows.find((r) => r.userId === expired.userId)?.status).toBe(
      "inactive",
    );
  });

  it("legend-i6ff a user whose assignment starts in the future is inactive", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const later = await staff(`${token} Nanti`, "cashier", {
      from: "now() + interval '1 hour'",
    });
    const rows = await list(admin.client, `?q=${token}`);
    expect(rows.find((r) => r.userId === later.userId)?.status).toBe(
      "inactive",
    );
  });

  it("legend-i6ff an expired assignment plus a current one is active", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const mixed = await staff(`${token} Campuran`, "cashier", {
      from: "now() - interval '2 hours'",
      until: "now() - interval '1 minute'",
    });
    await grant(mixed.userId, await roleIdOf("waiter"));
    const rows = await list(admin.client, `?q=${token}`);
    expect(rows.find((r) => r.userId === mixed.userId)?.status).toBe("active");
  });
});

describe("legend-i6ff GET /api/access/users paging and search", () => {
  it("legend-i6ff pages by cursor in name order without gaps or repeats", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    // Created out of order on purpose; the directory sorts by name asc.
    const charlie = await staff(`${token} Charlie`);
    const alpha = await staff(`${token} Alpha`);
    const bravo = await staff(`${token} Bravo`);

    const first = await admin.client.get(`${USERS}?q=${token}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.meta.limit).toBe(2);
    expect((first.body.data as Row[]).map((r) => r.displayName)).toEqual([
      `${token} Alpha`,
      `${token} Bravo`,
    ]);
    const cursor = first.body.meta.nextCursor as string | null;
    expect(typeof cursor).toBe("string");

    const second = await admin.client.get(
      `${USERS}?q=${token}&limit=2&cursor=${encodeURIComponent(cursor!)}`,
    );
    expect(second.status).toBe(200);
    expect((second.body.data as Row[]).map((r) => r.userId)).toEqual([
      charlie.userId,
    ]);
    expect(second.body.meta.nextCursor).toBeNull();
    expect(idsOf(first.body.data as Row[])).toEqual([
      alpha.userId,
      bravo.userId,
    ]);
  });

  it("legend-i6ff the last page of an exactly-full result has no nextCursor", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    await staff(`${token} Satu`);
    await staff(`${token} Dua`);
    const res = await admin.client.get(`${USERS}?q=${token}&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it("legend-i6ff q filters by name, case-insensitively, and an unmatched q gives an empty page", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const target = await staff(`${token} Budi Santoso`);
    const other = await staff(`${token} Siti Aminah`);

    const byName = await list(
      admin.client,
      `?q=${encodeURIComponent("budi sant")}`,
    );
    expect(idsOf(byName)).toContain(target.userId);
    expect(idsOf(byName)).not.toContain(other.userId);

    const upper = await list(admin.client, `?q=${token.toUpperCase()}`);
    expect(idsOf(upper)).toEqual(
      expect.arrayContaining([target.userId, other.userId]),
    );

    const none = await admin.client.get(`${USERS}?q=${token}-tidak-ada`);
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
    expect(none.body.meta.nextCursor).toBeNull();
  });

  it("legend-i6ff q treats % as a literal character, not a wildcard", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const literal = await staff(`${token}100% Murni`);
    const plain = await staff(`${token}100 Murni`);

    const exact = await list(
      admin.client,
      `?q=${encodeURIComponent(`${token}100%`)}`,
    );
    expect(idsOf(exact)).toEqual([literal.userId]);
    expect(idsOf(exact)).not.toContain(plain.userId);

    // A lone "%" matches only names that contain a percent sign.
    const lone = await list(
      admin.client,
      `?q=${encodeURIComponent("%")}&limit=100`,
    );
    expect(idsOf(lone)).not.toContain(plain.userId);
    const loneByToken = await list(
      admin.client,
      `?q=${encodeURIComponent(`${token}100% M`)}`,
    );
    expect(idsOf(loneByToken)).toEqual([literal.userId]);
  });

  it("legend-i6ff q treats _ as a literal character, not a single-character wildcard", async () => {
    const token = `Zq${unique()}`;
    const admin = await viewer();
    const literal = await staff(`${token}a_b Garis`);
    const wild = await staff(`${token}axb Garis`);
    const rows = await list(
      admin.client,
      `?q=${encodeURIComponent(`${token}a_b`)}`,
    );
    expect(idsOf(rows)).toEqual([literal.userId]);
    expect(idsOf(rows)).not.toContain(wild.userId);
  });
});
