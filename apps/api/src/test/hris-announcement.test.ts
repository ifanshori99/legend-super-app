// HRIS internal announcements against PostgreSQL with the restricted app role
// (RLS enforced): PRD v1.7 §3 F32; TEN-01/02/03; bead legend-7df1.
//
// Services are called directly with server-minted contexts (like
// hris-db.test.ts); a few HTTP tests cover the gates of the real Express app.
// Actors are real users with real role assignments.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { Announcement } from "@starter/shared/hris";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import {
  announcementOutlets,
  announcements,
} from "../db/schema/hris-announcement.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createAnnouncement,
  listAnnouncementReceipts,
  listAnnouncements,
  markAnnouncementRead,
} from "../services/hris-announcement.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = outletIdSchema.parse(randomUUID());
const run = randomUUID().slice(0, 8);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string, tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Pengumuman uji', $2)`,
    [userId, `${userId}@example.test`],
  );
  await grantRole(userId, permissions, scope, tenant);
  return userId;
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Ann test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
  name: string;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', $7)`,
      [
        id,
        tenantId,
        input.userId,
        `AN-${id.slice(0, 8).toUpperCase()}`,
        input.name,
        input.outletId,
        input.status ?? "active",
      ],
    ),
  );
  return id;
}

const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error), error };
  }
  throw new Error("Expected the call to fail");
}

const key = () => `ann-test-${randomUUID()}`;
const hoursFrom = (date: Date, hours: number) =>
  new Date(date.getTime() + hours * 3_600_000);

// Actors.
let managerAll: string; // hr.announcement.manage, tenant-wide
let managerA: string; // hr.announcement.manage, outlet A
let staffA1: string; // self.sop.read, outlet A
let staffA2: string; // self.sop.read, outlet A
let staffB: string; // self.sop.read, outlet B
let stranger: string; // no code
let managerOther: string; // hr.announcement.manage in the other tenant

// Employees.
let empA1: string;
let empA2: string;
let empA3: string; // no login, outlet A
let empB: string;
let empInactive: string; // resigned, outlet A

const names = {
  a1: `Ann-${run} A1`,
  a2: `Ann-${run} A2`,
  a3: `Ann-${run} A3`,
  b: `Ann-${run} B`,
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Announcement RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `ann-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });

  managerAll = await actor(["hr.announcement.manage"], { type: "tenant" });
  managerA = await actor(["hr.announcement.manage"], {
    type: "outlet",
    id: outletA,
  });
  staffA1 = await actor(["self.sop.read"], { type: "outlet", id: outletA });
  staffA2 = await actor(["self.sop.read"], { type: "outlet", id: outletA });
  staffB = await actor(["self.sop.read"], { type: "outlet", id: outletB });
  stranger = await actor(["self.profile.view"], {
    type: "outlet",
    id: outletA,
  });
  managerOther = await actor(
    ["hr.announcement.manage"],
    { type: "tenant" },
    otherTenant,
  );

  empA1 = await seedEmployee({
    userId: staffA1,
    outletId: outletA,
    name: names.a1,
  });
  empA2 = await seedEmployee({
    userId: staffA2,
    outletId: outletA,
    name: names.a2,
  });
  empA3 = await seedEmployee({
    userId: null,
    outletId: outletA,
    name: names.a3,
  });
  empB = await seedEmployee({
    userId: staffB,
    outletId: outletB,
    name: names.b,
  });
  empInactive = await seedEmployee({
    userId: null,
    outletId: outletA,
    name: `Ann-${run} Resign`,
    status: "resigned",
  });
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    const mine = "tenant_id = $1 AND published_by = ANY($2)";
    await client.query(
      `DELETE FROM announcement_receipts WHERE tenant_id = $1 AND announcement_id IN
         (SELECT id FROM announcements WHERE ${mine})`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM hris_announcement_outlets WHERE tenant_id = $1 AND announcement_id IN
         (SELECT id FROM announcements WHERE ${mine})`,
      [tenantId, createdUsers],
    );
    await client.query(`DELETE FROM announcements WHERE ${mine}`, [
      tenantId,
      createdUsers,
    ]);
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdEmployees],
    );
  });
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  await owner.query(`DELETE FROM announcements WHERE tenant_id = $1`, [
    otherTenant,
  ]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.query("DELETE FROM outlets WHERE tenant_id = $1", [otherTenant]);
  await owner.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
    otherTenant,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [otherTenant]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    title: `Pengumuman ${run}`,
    body: "Rapat staf Senin pukul 09.00.",
    audience: { kind: "all" },
    requiresReceipt: false,
    expiresAt: null,
    ...overrides,
  } as Parameters<typeof createAnnouncement>[2];
}

const outletsAudience = (...outletIds: string[]) =>
  ({ kind: "outlets", outletIds }) as const;

async function allRecipients(
  scope: ReturnType<typeof tenantScope>,
  user: string,
  announcementId: string,
  status?: "unread" | "read" | "acknowledged",
) {
  const rows = [];
  let cursor: string | undefined;
  let summary;
  do {
    const page = await listAnnouncementReceipts(scope, user, announcementId, {
      limit: 100,
      cursor,
      status,
    });
    rows.push(...page.data);
    summary = page.meta.summary;
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor);
  return {
    rows: rows.filter((row) => row.employeeName.startsWith(`Ann-${run}`)),
    summary,
  };
}

describe("announcement create and receipts list", () => {
  it("[F32] creates an all-employees announcement and lists recipients as unread, read and acknowledged", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input({ requiresReceipt: true }),
    );
    expect(created.audience).toEqual({ kind: "all" });
    expect(created.publishedBy).toBe(managerAll);

    const read = await markAnnouncementRead(
      outletScope(outletA),
      staffA1,
      created.id,
      { acknowledged: false, idempotencyKey: key() },
    );
    expect(read.acknowledgedAt).toBeNull();
    const acked = await markAnnouncementRead(
      outletScope(outletA),
      staffA2,
      created.id,
      { acknowledged: true, idempotencyKey: key() },
    );
    expect(acked.acknowledgedAt).not.toBeNull();

    const unread = await allRecipients(
      tenantScope(),
      managerAll,
      created.id,
      "unread",
    );
    expect(unread.rows.map((row) => row.employeeName).sort()).toEqual(
      [names.a3, names.b].sort(),
    );
    const readOnly = await allRecipients(
      tenantScope(),
      managerAll,
      created.id,
      "read",
    );
    expect(readOnly.rows.map((row) => row.employeeId)).toEqual([empA1]);
    const confirmed = await allRecipients(
      tenantScope(),
      managerAll,
      created.id,
      "acknowledged",
    );
    expect(confirmed.rows.map((row) => row.employeeId)).toEqual([empA2]);
    // Resigned employees are never recipients.
    const everyone = await allRecipients(tenantScope(), managerAll, created.id);
    expect(everyone.rows.map((row) => row.employeeId)).not.toContain(
      empInactive,
    );
    // Summary ignores the status filter; read counts everyone with a receipt.
    expect(everyone.summary.read).toBe(2);
    expect(everyone.summary.acknowledged).toBe(1);
    expect(everyone.summary.recipients).toBeGreaterThanOrEqual(4);
  });

  it("[F32] an outlet announcement reaches only that outlet's employees, and a manager of A sees only A recipients", async () => {
    const created = await createAnnouncement(
      outletScope(outletA),
      managerA,
      input({ audience: outletsAudience(outletA) }),
    );
    expect(created.audience).toEqual({ kind: "outlets", outletIds: [outletA] });
    const { rows } = await allRecipients(
      outletScope(outletA),
      managerA,
      created.id,
    );
    expect(rows.map((row) => row.employeeId).sort()).toEqual(
      [empA1, empA2, empA3].sort(),
    );
    const viaAll = await allRecipients(tenantScope(), managerAll, created.id);
    expect(viaAll.rows.map((row) => row.employeeId)).not.toContain(empB);
  });
});

describe("audience visibility", () => {
  it("[TEN-03] an employee of outlet B cannot see or mark an outlet-A announcement (404)", async () => {
    const created = await createAnnouncement(
      outletScope(outletA),
      managerA,
      input({ audience: outletsAudience(outletA) }),
    );
    const feedB = await listAnnouncements(outletScope(outletB), staffB, {
      limit: 100,
    });
    expect(feedB.data.map((item) => item.id)).not.toContain(created.id);
    expect(
      (
        await failure(
          markAnnouncementRead(outletScope(outletB), staffB, created.id, {
            acknowledged: true,
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(404);
    const feedA = await listAnnouncements(outletScope(outletA), staffA1, {
      limit: 100,
    });
    expect(feedA.data.map((item) => item.id)).toContain(created.id);
  });

  it("[F32] the feed is newest first, hides expired announcements from employees and keeps them for managers", async () => {
    const now = new Date();
    const expiring = await createAnnouncement(
      tenantScope(),
      managerAll,
      input({
        title: `Kedaluwarsa ${run}`,
        expiresAt: hoursFrom(now, 1).toISOString(),
      }),
      now,
    );
    const newest = await createAnnouncement(
      tenantScope(),
      managerAll,
      input({ title: `Terbaru ${run}` }),
      hoursFrom(now, 0.5),
    );
    const later = hoursFrom(now, 2);
    const staffFeed = await listAnnouncements(
      outletScope(outletA),
      staffA1,
      { limit: 100 },
      later,
    );
    const staffIds = staffFeed.data.map((item) => item.id);
    expect(staffIds).toContain(newest.id);
    expect(staffIds).not.toContain(expiring.id);
    const stamps = staffFeed.data.map((item) => item.publishedAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    // The expired one cannot be marked either.
    expect(
      (
        await failure(
          markAnnouncementRead(
            outletScope(outletA),
            staffA1,
            expiring.id,
            { acknowledged: false, idempotencyKey: key() },
            later,
          ),
        )
      ).status,
    ).toBe(404);
    const managerFeed = await listAnnouncements(
      tenantScope(),
      managerAll,
      { limit: 100 },
      later,
    );
    expect(managerFeed.data.map((item) => item.id)).toContain(expiring.id);
  });

  it("[F32] feed pages through a cursor without repeating rows", async () => {
    await createAnnouncement(tenantScope(), managerAll, input());
    await createAnnouncement(tenantScope(), managerAll, input());
    const first = await listAnnouncements(outletScope(outletA), staffA1, {
      limit: 1,
    });
    expect(first.data).toHaveLength(1);
    expect(first.meta.nextCursor).not.toBeNull();
    const second = await listAnnouncements(outletScope(outletA), staffA1, {
      limit: 1,
      cursor: first.meta.nextCursor ?? undefined,
    });
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  });

  it("[F32] a malformed cursor answers 422 on the feed and the receipts list, never a database error", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input(),
    );
    const cursors = [
      "not-a-cursor",
      encodeCursor(["2025-01-01T00:00:00.000Z", "bukan-uuid"]),
      encodeCursor(["bukan-waktu", randomUUID()]),
      encodeCursor(["+275760-09-13T00:00:00.000Z", randomUUID()]),
    ];
    for (const cursor of cursors) {
      const feed = await failure(
        listAnnouncements(outletScope(outletA), staffA1, { limit: 5, cursor }),
      );
      expect(feed.status).toBe(422);
      const managerFeed = await failure(
        listAnnouncements(tenantScope(), managerAll, { limit: 5, cursor }),
      );
      expect(managerFeed.status).toBe(422);
    }
    const receiptCursor = encodeCursor([names.a1, "bukan-uuid"]);
    const receipts = await failure(
      listAnnouncementReceipts(tenantScope(), managerAll, created.id, {
        limit: 5,
        cursor: receiptCursor,
      }),
    );
    expect(receipts.status).toBe(422);
    expect(receipts.code).toBe("VALIDATION_ERROR");
  });
});

describe("mark read", () => {
  it("[F32] read_at is set once and acknowledged_at is set once and never cleared; the same call replays", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input({ requiresReceipt: true }),
    );
    const t0 = new Date();
    const first = await markAnnouncementRead(
      outletScope(outletA),
      staffA1,
      created.id,
      { acknowledged: false, idempotencyKey: "ann-test-first-key" },
      t0,
    );
    const replay = await markAnnouncementRead(
      outletScope(outletA),
      staffA1,
      created.id,
      { acknowledged: false, idempotencyKey: "ann-test-first-key" },
      hoursFrom(t0, 1),
    );
    expect(replay).toEqual(first);

    const acked = await markAnnouncementRead(
      outletScope(outletA),
      staffA1,
      created.id,
      { acknowledged: true, idempotencyKey: key() },
      hoursFrom(t0, 2),
    );
    expect(acked.id).toBe(first.id);
    expect(acked.readAt).toBe(first.readAt);
    expect(acked.acknowledgedAt).toBe(hoursFrom(t0, 2).toISOString());

    const again = await markAnnouncementRead(
      outletScope(outletA),
      staffA1,
      created.id,
      { acknowledged: true, idempotencyKey: key() },
      hoursFrom(t0, 3),
    );
    const cleared = await markAnnouncementRead(
      outletScope(outletA),
      staffA1,
      created.id,
      { acknowledged: false, idempotencyKey: key() },
      hoursFrom(t0, 4),
    );
    for (const receipt of [again, cleared]) {
      expect(receipt.readAt).toBe(first.readAt);
      expect(receipt.acknowledgedAt).toBe(acked.acknowledgedAt);
    }
  });

  it("[HR-01] a user without an employee row cannot mark anything (404)", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input(),
    );
    const noRow = await actor(["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    expect(
      (
        await failure(
          markAnnouncementRead(outletScope(outletA), noRow, created.id, {
            acknowledged: false,
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("[HR-01] an employee who is no longer active sees an empty feed and cannot mark (404)", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input(),
    );
    const leaverUser = await actor(["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    const leaver = await seedEmployee({
      userId: leaverUser,
      outletId: outletA,
      name: `Ann-${run} Leaver`,
      status: "resigned",
    });
    const feed = await listAnnouncements(outletScope(outletA), leaverUser, {
      limit: 100,
    });
    expect(feed.data).toEqual([]);
    expect(
      (
        await failure(
          markAnnouncementRead(outletScope(outletA), leaverUser, created.id, {
            acknowledged: false,
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(404);

    // Onboarding staff still count as working employees.
    await asOwner(tenantId, (client) =>
      client.query(
        "UPDATE employees SET status = 'onboarding' WHERE tenant_id = $1 AND id = $2",
        [tenantId, leaver],
      ),
    );
    const receipt = await markAnnouncementRead(
      outletScope(outletA),
      leaverUser,
      created.id,
      { acknowledged: false, idempotencyKey: key() },
    );
    expect(receipt.announcementId).toBe(created.id);
    expect(
      (
        await listAnnouncements(outletScope(outletA), leaverUser, {
          limit: 100,
        })
      ).data.map((item) => item.id),
    ).toContain(created.id);
  });

  it("[F32] onboarding employees are recipients in the receipts list and the summary", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input(),
    );
    const before = await allRecipients(tenantScope(), managerAll, created.id);
    const newbie = await seedEmployee({
      userId: null,
      outletId: outletA,
      name: `Ann-${run} Newbie`,
      status: "onboarding",
    });
    const after = await allRecipients(tenantScope(), managerAll, created.id);
    expect(after.rows.map((row) => row.employeeId)).toContain(newbie);
    expect(after.summary.recipients).toBe(before.summary.recipients + 1);
    const unread = await allRecipients(
      tenantScope(),
      managerAll,
      created.id,
      "unread",
    );
    expect(unread.rows.map((row) => row.employeeId)).toContain(newbie);
  });
});

describe("scope and permissions", () => {
  it("[TEN-03] a manager of outlet A cannot target outlet B or everyone (403 OUTLET_OUT_OF_SCOPE)", async () => {
    const toB = await failure(
      createAnnouncement(
        outletScope(outletA),
        managerA,
        input({ audience: outletsAudience(outletA, outletB) }),
      ),
    );
    expect(toB.status).toBe(403);
    expect(toB.code).toBe("OUTLET_OUT_OF_SCOPE");
    const toAll = await failure(
      createAnnouncement(outletScope(outletA), managerA, input()),
    );
    expect(toAll.status).toBe(403);
    expect(toAll.code).toBe("OUTLET_OUT_OF_SCOPE");
  });

  it("[F32] an unknown outlet answers 404 and a past expiry 422", async () => {
    expect(
      (
        await failure(
          createAnnouncement(
            tenantScope(),
            managerAll,
            input({ audience: outletsAudience(randomUUID()) }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          createAnnouncement(
            tenantScope(),
            managerAll,
            input({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
          ),
        )
      ).status,
    ).toBe(422);
  });

  it("[TEN-03] a manager of A cannot read receipts of a B-only announcement (404)", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input({ audience: outletsAudience(outletB) }),
    );
    expect(
      (
        await failure(
          listAnnouncementReceipts(outletScope(outletA), managerA, created.id, {
            limit: 20,
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("[TEN-03] permission denied: no code, staff cannot publish or list receipts, a manager cannot mark", async () => {
    const created = await createAnnouncement(
      tenantScope(),
      managerAll,
      input(),
    );
    expect(
      (
        await failure(
          listAnnouncements(outletScope(outletA), stranger, { limit: 20 }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await failure(
          createAnnouncement(outletScope(outletA), staffA1, input()),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await failure(
          listAnnouncementReceipts(outletScope(outletA), staffA1, created.id, {
            limit: 20,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await failure(
          markAnnouncementRead(tenantScope(), managerAll, created.id, {
            acknowledged: false,
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(403);
  });
});

describe("cross-tenant isolation", () => {
  let created: Announcement;
  beforeAll(async () => {
    created = await createAnnouncement(
      outletScope(outletA),
      managerA,
      input({ audience: outletsAudience(outletA) }),
    );
  });

  it("[TEN-01] another tenant sees no announcement and gets 404 from the service", async () => {
    const rows = await withTenant(db, tenantScope(otherTenant), (tx) =>
      tx.select().from(announcements).where(eq(announcements.id, created.id)),
    );
    expect(rows).toEqual([]);
    expect(
      (
        await failure(
          listAnnouncementReceipts(
            tenantScope(otherTenant),
            managerOther,
            created.id,
            { limit: 20 },
          ),
        )
      ).status,
    ).toBe(404);
    const feed = await listAnnouncements(
      tenantScope(otherTenant),
      managerOther,
      { limit: 100 },
    );
    expect(feed.data.map((item) => item.id)).not.toContain(created.id);
  });

  it("[TEN-02] RLS refuses writing an announcement or an audience row into another tenant", async () => {
    await expect(
      withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.insert(announcements).values({
          tenantId,
          title: "Bocor",
          body: "x",
          audienceKind: "all",
          requiresReceipt: false,
          publishedBy: managerAll as never,
          publishedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.insert(announcementOutlets).values({
          tenantId,
          announcementId: created.id,
          outletId: outletA,
        }),
      ),
    ).rejects.toThrow();
  });

  it("[TEN-03] outlet RLS hides audience rows of outlets outside the scope and refuses writing them", async () => {
    const own = await withTenant(db, outletScope(outletA), (tx) =>
      tx
        .select()
        .from(announcementOutlets)
        .where(eq(announcementOutlets.announcementId, created.id)),
    );
    expect(own).toHaveLength(1);
    const foreign = await withTenant(db, outletScope(outletB), (tx) =>
      tx
        .select()
        .from(announcementOutlets)
        .where(
          and(
            eq(announcementOutlets.tenantId, tenantId),
            eq(announcementOutlets.announcementId, created.id),
          ),
        ),
    );
    expect(foreign).toEqual([]);
    await expect(
      withTenant(db, outletScope(outletB), (tx) =>
        tx.insert(announcementOutlets).values({
          tenantId,
          announcementId: created.id,
          outletId: outletA,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("announcements over HTTP", () => {
  type Client = ReturnType<typeof agent>;
  async function signedIn(
    name: string,
    permissions: string[],
    scope: { type: "tenant" } | { type: "outlet"; id: string },
    outletForEmployee: string | null,
  ) {
    const client = agent(app);
    await signUp(client, name);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUsers.push(userId);
    await grantRole(userId, permissions, scope);
    const employeeId =
      outletForEmployee === null
        ? null
        : await seedEmployee({
            userId,
            outletId: outletForEmployee,
            name: `Ann-${run} HTTP ${name}`,
          });
    return { client, userId, employeeId };
  }

  let manager: Client;
  let staffHttpA: Client;
  let staffHttpB: Client;
  let strangerHttp: Client;

  beforeAll(async () => {
    manager = (
      await signedIn(
        "Mgr",
        ["hr.announcement.manage"],
        { type: "tenant" },
        null,
      )
    ).client;
    staffHttpA = (
      await signedIn(
        "StaffA",
        ["self.sop.read"],
        { type: "outlet", id: outletA },
        outletA,
      )
    ).client;
    staffHttpB = (
      await signedIn(
        "StaffB",
        ["self.sop.read"],
        { type: "outlet", id: outletB },
        outletB,
      )
    ).client;
    strangerHttp = (
      await signedIn(
        "Nobody",
        ["self.profile.view"],
        { type: "outlet", id: outletA },
        null,
      )
    ).client;
  });

  it("[legend-poxk] hr.sop.manage alone cannot publish or read receipts (kitchen_lead keeps SOP, not announcements)", async () => {
    const sopOnly = (
      await signedIn(
        "SopOnly",
        ["hr.sop.manage"],
        { type: "outlet", id: outletA },
        null,
      )
    ).client;
    const published = await manager
      .post("/api/hris/announcements")
      .set(originHeader)
      .send({
        title: `Receipts ${run}`,
        body: "Isi.",
        audience: { kind: "outlets", outletIds: [outletA] },
        requiresReceipt: true,
        expiresAt: null,
      });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const id = published.body.data.id as string;

    const create = await sopOnly
      .post("/api/hris/announcements")
      .set(originHeader)
      .send({
        title: `Nope ${run}`,
        body: "Isi.",
        audience: { kind: "outlets", outletIds: [outletA] },
        requiresReceipt: false,
        expiresAt: null,
      });
    expect(create.status).toBe(403);
    const receipts = await sopOnly.get(
      `/api/hris/announcements/${id}/receipts`,
    );
    expect(receipts.status).toBe(403);
  });

  it("[TEN-01] anonymous requests answer 401", async () => {
    const anonymous = agent(app);
    expect((await anonymous.get("/api/hris/announcements")).status).toBe(401);
  });

  it("[F32] manager publishes, staff reads and confirms, manager sees the receipt summary", async () => {
    const created = await manager
      .post("/api/hris/announcements")
      .set(originHeader)
      .send({
        title: `HTTP ${run}`,
        body: "Libur nasional.",
        audience: { kind: "outlets", outletIds: [outletA] },
        requiresReceipt: true,
        expiresAt: null,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.data.id as string;

    const feed = await staffHttpA.get("/api/hris/announcements?limit=100");
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect(feed.body.data.map((item: { id: string }) => item.id)).toContain(id);

    const mark = await staffHttpA
      .post(`/api/hris/announcements/${id}/receipts`)
      .set(originHeader)
      .send({ acknowledged: true, idempotencyKey: key() });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    expect(mark.body.data.acknowledgedAt).not.toBeNull();

    const receipts = await manager.get(
      `/api/hris/announcements/${id}/receipts?status=acknowledged`,
    );
    expect(receipts.status, JSON.stringify(receipts.body)).toBe(200);
    expect(receipts.body.data).toHaveLength(1);
    expect(receipts.body.meta.summary.acknowledged).toBe(1);
  });

  it("[TEN-03] staff of outlet B gets 404 on an outlet-A announcement; staff cannot publish; a stranger is refused", async () => {
    const created = await manager
      .post("/api/hris/announcements")
      .set(originHeader)
      .send({
        title: `HTTP A ${run}`,
        body: "Hanya outlet A.",
        audience: { kind: "outlets", outletIds: [outletA] },
        requiresReceipt: false,
        expiresAt: null,
      });
    const id = created.body.data.id as string;
    const mark = await staffHttpB
      .post(`/api/hris/announcements/${id}/receipts`)
      .set(originHeader)
      .send({ acknowledged: false, idempotencyKey: key() });
    expect(mark.status).toBe(404);
    const publish = await staffHttpA
      .post("/api/hris/announcements")
      .set(originHeader)
      .send({
        title: "x",
        body: "x",
        audience: { kind: "all" },
        requiresReceipt: false,
        expiresAt: null,
      });
    expect(publish.status).toBe(403);
    expect((await strangerHttp.get("/api/hris/announcements")).status).toBe(
      403,
    );
    // A mutation without Origin is refused before anything else.
    const noOrigin = await manager.post("/api/hris/announcements").send({});
    expect(noOrigin.status).toBe(403);
  });
});
