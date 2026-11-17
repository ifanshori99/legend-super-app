// legend-vqicf: the `customer_reviews` table, the staff review routes
// (GET/POST /api/reviews, PATCH /api/reviews/:id/moderation) and the dashboard
// `reviews` queue. Written from docs/briefs/981-reviews.md "Kontrak" and the
// shared validators, not from the implementation. Fail-first: the table, the
// routes and the zod contract do not exist yet.
//
// Assumptions (the brief does not pin these down):
// - Missing permission is 403 PERMISSION_DENIED; no session is 401 (as
//   crm-feedback.test.ts).
// - Role split: GET needs `review.respond`; POST and PATCH moderation need
//   `crm.feedback.manage`. Role used for "has review.respond but not
//   crm.feedback.manage" is the `marketing` template (tenant scope). A cashier
//   has neither. Owner and outlet_manager hold both.
// - Success statuses: GET 200, PATCH 200, POST 200 or 201. List shape is
//   `{ data: [...], meta: { nextCursor } }` (cursor page, like feedback).
// - DTO keys are camelCase of the columns: id, tenantId, outletId, rating,
//   body, source, moderationStatus, moderatedBy, moderatedAt, moderationNote,
//   createdAt. A new review is `pending`; PATCH sets moderatedBy to the acting
//   staff user id and moderatedAt to a time.
// - POST by staff is a manual entry: the stored `source` is 'manual'. Tests
//   always send source "manual", so they do not depend on whether the server
//   forces or validates it.
// - An outlet-scoped manager reading or moderating another outlet's review, or
//   posting for another outlet, gets 403 or 404 (and the row is unchanged); a
//   list filtered to another outlet gives 200 or 403 and never that row.
// - A moderation PATCH on an unknown id is 404 NOT_FOUND; malformed id, extra
//   keys, unknown status and over-long note are 400 or 422.
// - Dashboard queue row `excerpt` would be derived from `body`, which must never
//   reach the queue, so it is null. `reviewId` is the review id. Pending rows
//   come before published ones.
// - The seeded tenant is shared with other suites: list checks look for
//   specific ids, never exact totals. The empty state is checked in a fresh
//   isolated tenant.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboardQueueRowsSchema } from "@starter/shared/dashboard";
import { createApp } from "../app";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";
import {
  asTenant as asAppTenant,
  createAppPool,
  expectRowsIsolated,
} from "./tenant-isolation-harness";

const tag = randomUUID().slice(0, 8);
const bodyOf = (label: string) => `rv-${tag}-${label}-${randomUUID()}`;

let app: Express;
let appPool: Pool;
let tenantB: IsolatedTenant;
let ownerA: Staff; // tenant scope, review.respond + crm.feedback.manage
let managerX: Staff; // outlet_manager scoped to outlet A only
let marketing: Staff; // review.respond, no crm.feedback.manage
let cashier: Staff; // neither permission
let staffB: Staff; // tenant B, custom role with both permissions

type Seed = {
  tenantId?: string;
  outletId?: string;
  rating?: number;
  body?: string | null;
  source?: string;
  status?: "pending" | "published" | "hidden";
  createdAt?: string;
};

/** Owner-role SQL inside the tenant GUCs (the table is FORCE RLS). */
async function sql(
  tenantId: string,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedReview(seed: Seed = {}): Promise<{
  id: string;
  body: string;
  tenantId: string;
  outletId: string;
}> {
  const id = randomUUID();
  const tenantId = seed.tenantId ?? seededTenantId;
  const outletId = seed.outletId ?? seededOutletA;
  const body = seed.body === undefined ? bodyOf("seed") : seed.body;
  await sql(
    tenantId,
    `INSERT INTO customer_reviews
       (id, tenant_id, outlet_id, rating, body, source, moderation_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))`,
    [
      id,
      tenantId,
      outletId,
      seed.rating ?? 4,
      body,
      seed.source ?? "web",
      seed.status ?? "pending",
      seed.createdAt ?? null,
    ],
  );
  return { id, body: body ?? "", tenantId, outletId };
}

async function reviewRow(tenantId: string, id: string) {
  const { rows } = await sql(
    tenantId,
    `SELECT id, tenant_id, outlet_id, rating, body, source, moderation_status,
            moderated_by, moderated_at, moderation_note
       FROM customer_reviews WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

async function countTagged(tenantId: string): Promise<number> {
  const { rows } = await sql(
    tenantId,
    `SELECT count(*)::int AS n FROM customer_reviews
      WHERE tenant_id = $1 AND body LIKE $2`,
    [tenantId, `rv-${tag}-%`],
  );
  return rows[0]!.n as number;
}

const list = (staff: Staff, query = "", host = seededHostname) =>
  staff.client.get(`/api/reviews${query}`).set("Host", host);

const create = (
  staff: Staff,
  body: Record<string, unknown>,
  host = seededHostname,
) =>
  staff.client
    .post("/api/reviews")
    .set("Host", host)
    .set(originHeader)
    .send(body);

const moderate = (
  staff: Staff,
  id: string,
  body: Record<string, unknown>,
  host = seededHostname,
) =>
  staff.client
    .patch(`/api/reviews/${id}/moderation`)
    .set("Host", host)
    .set(originHeader)
    .send(body);

const idsOf = (response: { body: { data: { id: string }[] } }) =>
  response.body.data.map((item) => item.id);

const validBody = (extra: Record<string, unknown> = {}) => ({
  outletId: seededOutletA,
  rating: 4,
  body: bodyOf("post"),
  source: "manual",
  ...extra,
});

beforeAll(async () => {
  app = createApp();
  appPool = createAppPool();
  tenantB = await createIsolatedTenant(`rv${tag}`);
  // The isolated tenant's custom role carries floor permissions only; grant
  // the two review permissions so tenant B can use the routes.
  await owner.query(
    `UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1`,
    [tenantB.roleId, JSON.stringify(["review.respond", "crm.feedback.manage"])],
  );
  staffB = await staffOfIsolatedTenant(app, tenantB);
  ownerA = await staffWithRole(app, {
    template: "owner",
    label: "Owner Ulasan",
  });
  managerX = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Manajer Ulasan X",
  });
  marketing = await staffWithRole(app, {
    template: "marketing" as never,
    label: "Marketing Ulasan",
  });
  cashier = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Kasir Ulasan",
  });
});

afterAll(async () => {
  await sql(
    seededTenantId,
    `DELETE FROM customer_reviews WHERE tenant_id = $1 AND body LIKE $2`,
    [seededTenantId, `rv-${tag}-%`],
  );
  await sql(
    tenantB.tenantId,
    `DELETE FROM customer_reviews WHERE tenant_id = $1`,
    [tenantB.tenantId],
  );
  await dropIsolatedTenant(tenantB);
  await appPool.end();
});

describe("legend-vqicf customer_reviews table constraints", () => {
  it("legend-vqicf a new review defaults to pending and stores the contract columns", async () => {
    const id = randomUUID();
    await sql(
      seededTenantId,
      `INSERT INTO customer_reviews (id, tenant_id, outlet_id, rating, body, source)
       VALUES ($1, $2, $3, 5, $4, 'qr')`,
      [id, seededTenantId, seededOutletA, bodyOf("default")],
    );
    const row = await reviewRow(seededTenantId, id);
    expect(row).toMatchObject({
      rating: 5,
      source: "qr",
      moderation_status: "pending",
      moderated_by: null,
      moderated_at: null,
      moderation_note: null,
    });
  });

  it.each([
    ["rating 0", { rating: 0 }],
    ["rating 6", { rating: 6 }],
    ["unknown source", { source: "tiktok" }],
    ["unknown moderation status", { status: "deleted" as never }],
  ])(
    "legend-vqicf the database refuses %s (check constraint)",
    async (_, seed) => {
      await expect(seedReview(seed as Seed)).rejects.toMatchObject({
        code: "23514",
      });
    },
  );

  it("legend-vqicf the database refuses a body over 2000 characters", async () => {
    await expect(seedReview({ body: "x".repeat(2001) })).rejects.toMatchObject({
      code: "22001",
    });
  });

  it("legend-vqicf a review may have no body", async () => {
    const seeded = await seedReview({ body: null });
    expect((await reviewRow(seededTenantId, seeded.id))!.body).toBeNull();
    await sql(seededTenantId, "DELETE FROM customer_reviews WHERE id = $1", [
      seeded.id,
    ]);
  });
});

describe("legend-vqicf tenant A/B isolation (SQL and RLS)", () => {
  it("legend-vqicf each tenant sees only its own review, cannot update the other's, has no DELETE, and sees nothing without a tenant", async () => {
    const a = await seedReview();
    const b = await seedReview({
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
    });
    await expectRowsIsolated(
      appPool,
      {
        table: "customer_reviews",
        updateSet: "moderation_note = 'x'",
        deleteRevoked: true,
        tenantA: { tenantId: seededTenantId, rowId: a.id },
        tenantB: { tenantId: tenantB.tenantId, rowId: b.id },
      },
      owner,
    );
  });

  it("legend-vqicf a tenant cannot insert a review for another tenant", async () => {
    await expect(
      asAppTenant(appPool, tenantB.tenantId, (client) =>
        client.query(
          `INSERT INTO customer_reviews (tenant_id, outlet_id, rating, source)
           VALUES ($1, $2, 3, 'web')`,
          [seededTenantId, seededOutletA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("legend-vqicf legend_app may read, insert and update but has no DELETE or TRUNCATE grant", async () => {
    const { rows } = await owner.query<{ priv: string; ok: boolean }>(
      `SELECT p AS priv, has_table_privilege('legend_app', 'customer_reviews', p) AS ok
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p`,
    );
    const granted = Object.fromEntries(rows.map((r) => [r.priv, r.ok]));
    expect(granted).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: true,
      DELETE: false,
      TRUNCATE: false,
    });
  });

  it("legend-vqicf even a tenant's own review cannot be deleted by the app role", async () => {
    const own = await seedReview();
    await expect(
      asAppTenant(appPool, seededTenantId, (client) =>
        client.query("DELETE FROM customer_reviews WHERE id = $1", [own.id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await reviewRow(seededTenantId, own.id)).not.toBeNull();
  });
});

describe("legend-vqicf outlet X/Y isolation (SQL and RLS)", () => {
  it("legend-vqicf an outlet-scoped session reads and updates only its outlet's reviews and cannot insert for another outlet", async () => {
    const x = await seedReview({ outletId: seededOutletA });
    const y = await seedReview({ outletId: seededOutletB });
    const both = [x.id, y.id];

    await asAppTenant(
      appPool,
      seededTenantId,
      async (client) => {
        const seen = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM customer_reviews WHERE id = ANY($1::uuid[])",
          [both],
        );
        expect(seen.rows.map((r) => r.id)).toEqual([x.id]);
        const updated = await client.query(
          "UPDATE customer_reviews SET moderation_note = 'x' WHERE id = $1",
          [y.id],
        );
        expect(updated.rowCount).toBe(0);
      },
      [seededOutletA],
    );

    await asAppTenant(
      appPool,
      seededTenantId,
      async (client) => {
        const seen = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM customer_reviews WHERE id = ANY($1::uuid[])",
          [both],
        );
        expect(seen.rows.map((r) => r.id)).toEqual([y.id]);
      },
      [seededOutletB],
    );

    await asAppTenant(appPool, seededTenantId, async (client) => {
      const seen = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM customer_reviews WHERE id = ANY($1::uuid[])",
        [both],
      );
      expect(seen.rows.map((r) => r.id).sort()).toEqual([...both].sort());
    });

    await expect(
      asAppTenant(
        appPool,
        seededTenantId,
        (client) =>
          client.query(
            `INSERT INTO customer_reviews (tenant_id, outlet_id, rating, source)
             VALUES ($1, $2, 3, 'web')`,
            [seededTenantId, seededOutletB],
          ),
        [seededOutletA],
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("legend-vqicf review list: access and isolation over HTTP", () => {
  it("legend-vqicf staff with review.respond list reviews, newest data of own tenant only", async () => {
    const mine = await seedReview({ outletId: seededOutletA });
    const other = await seedReview({
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
    });

    const response = await list(ownerA, "?limit=100");

    expect(response.status).toBe(200);
    expect(response.body.meta).toHaveProperty("nextCursor");
    expect(idsOf(response)).toContain(mine.id);
    expect(idsOf(response)).not.toContain(other.id);
    const item = response.body.data.find(
      (r: { id: string }) => r.id === mine.id,
    );
    expect(item).toMatchObject({
      tenantId: seededTenantId,
      outletId: seededOutletA,
      rating: 4,
      source: "web",
      moderationStatus: "pending",
    });
    expect(JSON.stringify(response.body)).not.toContain(other.id);
  });

  it("legend-vqicf a review of tenant A never shows for tenant B staff, and tenant B sees its own", async () => {
    const a = await seedReview({ outletId: seededOutletA });
    const b = await seedReview({
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
    });

    const response = await list(staffB, "?limit=100", tenantB.hostname);

    expect(response.status).toBe(200);
    expect(idsOf(response)).toContain(b.id);
    expect(idsOf(response)).not.toContain(a.id);
  });

  it("legend-vqicf a tenant with no reviews gets an empty list", async () => {
    const fresh = await createIsolatedTenant(`rvempty${tag}`);
    try {
      await owner.query(
        `UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1`,
        [fresh.roleId, JSON.stringify(["review.respond"])],
      );
      const staff = await staffOfIsolatedTenant(app, fresh);

      const response = await list(staff, "", fresh.hostname);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.nextCursor).toBeNull();
    } finally {
      await dropIsolatedTenant(fresh);
    }
  });

  it("legend-vqicf the list filters by outlet and by moderation status", async () => {
    const pendingA = await seedReview({ outletId: seededOutletA });
    const publishedB = await seedReview({
      outletId: seededOutletB,
      status: "published",
    });

    const atB = await list(ownerA, `?outletId=${seededOutletB}&limit=100`);
    expect(idsOf(atB)).toContain(publishedB.id);
    expect(idsOf(atB)).not.toContain(pendingA.id);
    expect(
      atB.body.data.every(
        (r: { outletId: string }) => r.outletId === seededOutletB,
      ),
    ).toBe(true);

    const published = await list(
      ownerA,
      "?moderationStatus=published&limit=100",
    );
    expect(idsOf(published)).toContain(publishedB.id);
    expect(idsOf(published)).not.toContain(pendingA.id);
    expect(
      published.body.data.every(
        (r: { moderationStatus: string }) => r.moderationStatus === "published",
      ),
    ).toBe(true);
  });

  it("legend-vqicf an unknown moderation status filter is invalid (400 or 422)", async () => {
    const response = await list(ownerA, "?moderationStatus=bogus");
    expect([400, 422]).toContain(response.status);
  });

  it("legend-vqicf the list is paged: a page of one gives a cursor and the next page continues without repeats", async () => {
    await seedReview();
    await seedReview();

    const first = await list(ownerA, "?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await list(
      ownerA,
      `?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it("legend-vqicf paging never skips rows that share one millisecond but differ in microseconds", async () => {
    const ids: string[] = [];
    const base = "2031-03-04 05:06:07.123";
    const inserts = [100, 200, 300, 400, 500].map((micro) => {
      const id = randomUUID();
      ids.push(id);
      return { id, createdAt: `${base}${micro}+00` };
    });
    for (const row of inserts)
      await sql(
        seededTenantId,
        `INSERT INTO customer_reviews (id, tenant_id, outlet_id, rating, body, source, created_at)
         VALUES ($1, $2, $3, 4, $4, 'web', $5::timestamptz)`,
        [row.id, seededTenantId, seededOutletA, bodyOf("micro"), row.createdAt],
      );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response: Awaited<ReturnType<typeof list>> = await list(
        ownerA,
        `?limit=2&outletId=${seededOutletA}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      expect(response.status).toBe(200);
      seen.push(...idsOf(response));
      cursor = response.body.meta.nextCursor as string | null;
      if (!cursor) break;
    }

    const mine = seen.filter((id) => ids.includes(id));
    expect([...mine].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("legend-vqicf an outlet-scoped manager sees only their own outlet, even when the filter names the other outlet", async () => {
    const x = await seedReview({ outletId: seededOutletA });
    const y = await seedReview({ outletId: seededOutletB });

    const own = await list(managerX, "?limit=100");
    expect(own.status).toBe(200);
    expect(idsOf(own)).toContain(x.id);
    expect(idsOf(own)).not.toContain(y.id);

    const filtered = await list(
      managerX,
      `?outletId=${seededOutletB}&limit=100`,
    );
    expect([200, 403]).toContain(filtered.status);
    expect(JSON.stringify(filtered.body)).not.toContain(y.id);
  });

  it("legend-vqicf a role without review.respond (cashier) gets 403 PERMISSION_DENIED on GET", async () => {
    const item = await seedReview();

    const response = await list(cashier);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(response.body)).not.toContain(item.id);
  });

  it("legend-vqicf a visitor who is not signed in gets 401 on every review route", async () => {
    const item = await seedReview();
    const anon = agent(app);

    expect(
      (await anon.get("/api/reviews").set("Host", seededHostname)).status,
    ).toBe(401);
    expect(
      (
        await anon
          .post("/api/reviews")
          .set("Host", seededHostname)
          .set(originHeader)
          .send(validBody())
      ).status,
    ).toBe(401);
    expect(
      (
        await anon
          .patch(`/api/reviews/${item.id}/moderation`)
          .set("Host", seededHostname)
          .set(originHeader)
          .send({ status: "published", expectedStatus: "pending" })
      ).status,
    ).toBe(401);
    expect((await reviewRow(seededTenantId, item.id))!.moderation_status).toBe(
      "pending",
    );
  });
});

describe("legend-vqicf manual entry (POST /api/reviews)", () => {
  it("legend-vqicf staff with crm.feedback.manage add a manual review that starts pending", async () => {
    const body = validBody({ rating: 5 });

    const response = await create(ownerA, body);

    expect([200, 201]).toContain(response.status);
    expect(response.body.data).toMatchObject({
      tenantId: seededTenantId,
      outletId: seededOutletA,
      rating: 5,
      body: body.body,
      source: "manual",
      moderationStatus: "pending",
    });
    const row = await reviewRow(seededTenantId, response.body.data.id);
    expect(row).toMatchObject({
      tenant_id: seededTenantId,
      outlet_id: seededOutletA,
      rating: 5,
      body: body.body,
      source: "manual",
      moderation_status: "pending",
    });
    expect(idsOf(await list(ownerA, "?limit=100"))).toContain(
      response.body.data.id,
    );
  });

  it("legend-vqicf a review without a body is accepted", async () => {
    const response = await create(ownerA, {
      outletId: seededOutletA,
      rating: 3,
      source: "manual",
    });

    expect([200, 201]).toContain(response.status);
    expect(response.body.data.body).toBeNull();
  });

  it("legend-vqicf a staff member's review lands in their own tenant, never one named in the body", async () => {
    const body = validBody();

    const response = await create(staffB, body, tenantB.hostname);

    // Outlet A belongs to tenant A: tenant B staff cannot file a review there.
    expect([400, 403, 404, 422]).toContain(response.status);
    const { rows } = await sql(
      seededTenantId,
      `SELECT count(*)::int AS n FROM customer_reviews WHERE body = $1`,
      [body.body],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it.each([
    ["rating 0", { rating: 0 }],
    ["rating 6", { rating: 6 }],
    ["fractional rating", { rating: 3.5 }],
    ["missing rating", { rating: undefined }],
    ["unknown source", { source: "tiktok" }],
    ["non-manual source google", { source: "google" }],
    ["non-manual source qr", { source: "qr" }],
    ["missing source", { source: undefined }],
    ["body over 2000 characters", { body: "x".repeat(2001) }],
    ["malformed outlet id", { outletId: "not-a-uuid" }],
    ["malformed order id", { orderId: "not-an-id" }],
    ["extra key tenantId", { tenantId: randomUUID() }],
    ["extra key moderationStatus", { moderationStatus: "published" }],
    ["extra key unknown", { surprise: true }],
  ])(
    "legend-vqicf strict validation refuses %s with 400 or 422",
    async (_, extra) => {
      const body = validBody(extra);
      const before = await countTagged(seededTenantId);

      const response = await create(ownerA, body);

      expect([400, 422]).toContain(response.status);
      expect(await countTagged(seededTenantId)).toBe(before);
    },
  );

  it("legend-vqicf a role without crm.feedback.manage gets 403 on POST: marketing (has review.respond) and cashier", async () => {
    for (const staff of [marketing, cashier]) {
      const body = validBody();
      const response = await create(staff, body);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
      const { rows } = await sql(
        seededTenantId,
        `SELECT count(*)::int AS n FROM customer_reviews WHERE body = $1`,
        [body.body],
      );
      expect(rows[0]!.n).toBe(0);
    }
  });

  it("legend-vqicf an outlet-scoped manager cannot add a review for another outlet", async () => {
    const body = validBody({ outletId: seededOutletB });

    const response = await create(managerX, body);

    expect([403, 404]).toContain(response.status);
    const { rows } = await sql(
      seededTenantId,
      `SELECT count(*)::int AS n FROM customer_reviews WHERE body = $1`,
      [body.body],
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe("legend-vqicf moderation (PATCH /api/reviews/:id/moderation)", () => {
  it("legend-vqicf publishing a pending review records who, when and the note", async () => {
    const review = await seedReview();

    const response = await moderate(ownerA, review.id, {
      status: "published",
      expectedStatus: "pending",
      note: "Ulasan sopan.",
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: review.id,
      moderationStatus: "published",
      moderatedBy: ownerA.userId,
      moderationNote: "Ulasan sopan.",
    });
    expect(response.body.data.moderatedAt).toEqual(expect.any(String));
    expect(await reviewRow(seededTenantId, review.id)).toMatchObject({
      moderation_status: "published",
      moderated_by: ownerA.userId,
      moderation_note: "Ulasan sopan.",
    });
    expect(
      (await reviewRow(seededTenantId, review.id))!.moderated_at,
    ).not.toBeNull();
  });

  it("legend-vqicf a review can be hidden and put back to pending", async () => {
    const review = await seedReview();

    const hidden = await moderate(ownerA, review.id, {
      status: "hidden",
      expectedStatus: "pending",
    });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.moderationStatus).toBe("hidden");

    const pending = await moderate(ownerA, review.id, {
      status: "pending",
      expectedStatus: "hidden",
    });
    expect(pending.status).toBe(200);
    expect(pending.body.data.moderationStatus).toBe("pending");
    expect(
      (await reviewRow(seededTenantId, review.id))!.moderation_status,
    ).toBe("pending");
  });

  it("legend-vqicf two moderators: the second one acting on a stale expectedStatus gets 409 REVIEW_STATUS_CONFLICT and the row keeps the first decision", async () => {
    const review = await seedReview();

    const first = await moderate(ownerA, review.id, {
      status: "published",
      expectedStatus: "pending",
      note: "Moderator pertama.",
    });
    expect(first.status).toBe(200);
    const second = await moderate(managerX, review.id, {
      status: "hidden",
      expectedStatus: "pending",
      note: "Moderator kedua, data basi.",
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("REVIEW_STATUS_CONFLICT");
    expect(await reviewRow(seededTenantId, review.id)).toMatchObject({
      moderation_status: "published",
      moderated_by: ownerA.userId,
      moderation_note: "Moderator pertama.",
    });
  });

  it("legend-vqicf an unknown review id answers 404 NOT_FOUND", async () => {
    const response = await moderate(ownerA, randomUUID(), {
      status: "published",
      expectedStatus: "pending",
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("legend-vqicf a role without crm.feedback.manage gets 403 on PATCH: marketing (has review.respond) and cashier; the row is unchanged", async () => {
    for (const staff of [marketing, cashier]) {
      const review = await seedReview();

      const response = await moderate(staff, review.id, {
        status: "published",
        expectedStatus: "pending",
        note: "tidak boleh",
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
      expect(await reviewRow(seededTenantId, review.id)).toMatchObject({
        moderation_status: "pending",
        moderated_by: null,
        moderation_note: null,
      });
    }
  });

  it("legend-vqicf an outlet-scoped manager moderates their own outlet's review but not another outlet's", async () => {
    const x = await seedReview({ outletId: seededOutletA });
    const y = await seedReview({ outletId: seededOutletB });

    expect(
      (
        await moderate(managerX, x.id, {
          status: "published",
          expectedStatus: "pending",
        })
      ).status,
    ).toBe(200);
    const foreign = await moderate(managerX, y.id, {
      status: "published",
      expectedStatus: "pending",
    });
    expect([403, 404]).toContain(foreign.status);
    expect((await reviewRow(seededTenantId, y.id))!.moderation_status).toBe(
      "pending",
    );
  });

  it("legend-vqicf a tenant B moderator cannot touch a tenant A review", async () => {
    const review = await seedReview();

    const response = await moderate(
      staffB,
      review.id,
      { status: "hidden", expectedStatus: "pending" },
      tenantB.hostname,
    );

    expect([403, 404]).toContain(response.status);
    expect(
      (await reviewRow(seededTenantId, review.id))!.moderation_status,
    ).toBe("pending");
  });

  it.each([
    ["unknown status", { status: "deleted", expectedStatus: "pending" }],
    ["missing status", { expectedStatus: "pending", note: "saja" }],
    ["missing expectedStatus", { status: "hidden" }],
    ["unknown expectedStatus", { status: "hidden", expectedStatus: "deleted" }],
    ["empty body", {}],
    [
      "note over 500 characters",
      { status: "hidden", expectedStatus: "pending", note: "x".repeat(501) },
    ],
    [
      "extra key rating",
      { status: "hidden", expectedStatus: "pending", rating: 1 },
    ],
    [
      "extra key body",
      { status: "hidden", expectedStatus: "pending", body: "ubah isi" },
    ],
    [
      "extra key moderatedBy",
      { status: "hidden", expectedStatus: "pending", moderatedBy: "someone" },
    ],
  ])(
    "legend-vqicf strict validation refuses %s with 400 or 422 and leaves the row unchanged",
    async (_, payload) => {
      const review = await seedReview();

      const response = await moderate(ownerA, review.id, payload);

      expect([400, 422]).toContain(response.status);
      expect(await reviewRow(seededTenantId, review.id)).toMatchObject({
        moderation_status: "pending",
        moderated_by: null,
        moderation_note: null,
        body: review.body,
        rating: 4,
      });
    },
  );

  it("legend-vqicf a malformed review id is invalid (400 or 422)", async () => {
    const response = await moderate(ownerA, "not-a-uuid", {
      status: "published",
      expectedStatus: "pending",
    });

    expect([400, 422]).toContain(response.status);
  });

  it("legend-vqicf there is no DELETE route for reviews", async () => {
    const review = await seedReview();

    const response = await ownerA.client
      .delete(`/api/reviews/${review.id}`)
      .set("Host", seededHostname)
      .set(originHeader);

    expect([404, 405]).toContain(response.status);
    expect(await reviewRow(seededTenantId, review.id)).not.toBeNull();
  });
});

describe("legend-vqicf dashboard reviews queue", () => {
  const queue = (staff: Staff, query = "") =>
    staff.client
      .get(`/api/dashboards/queues/reviews/rows${query}`)
      .set("Host", seededHostname);

  it("legend-vqicf the queue returns table rows (available, not 'source_not_built'), pending first, and never the review body", async () => {
    const pending = await seedReview({
      status: "pending",
      rating: 2,
      source: "google",
      body: bodyOf("queue-pending"),
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const published = await seedReview({
      status: "published",
      rating: 5,
      body: bodyOf("queue-published"),
    });

    const response = await queue(ownerA, "?limit=100");

    expect(response.status).toBe(200);
    const parsed = dashboardQueueRowsSchema.parse(response.body.data);
    expect(parsed.queue).toBe("reviews");
    expect(parsed.availability).toEqual({ status: "available" });
    if (parsed.queue !== "reviews") throw new Error("wrong queue");
    const ids = parsed.rows.map((row) => row.reviewId);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(published.id);
    // Pending rows come first, even when older than a published one.
    expect(ids.indexOf(pending.id)).toBeLessThan(ids.indexOf(published.id));
    const pendingRow = parsed.rows.find((row) => row.reviewId === pending.id)!;
    expect(pendingRow).toMatchObject({
      outletId: seededOutletA,
      rating: 2,
      source: "google",
      replied: false,
    });
    // PII: the body (and any excerpt of it) never reaches the queue.
    expect(pendingRow.excerpt).toBeNull();
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(pending.body);
    expect(text).not.toContain(published.body);
    expect(text).not.toContain(`rv-${tag}`);
  });

  it("legend-vqicf the queue filters by outlet and keeps tenant B's reviews out", async () => {
    const atB = await seedReview({ outletId: seededOutletB });
    const atA = await seedReview({ outletId: seededOutletA });
    const foreign = await seedReview({
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
    });

    const response = await queue(
      ownerA,
      `?outletIds=${seededOutletB}&limit=100`,
    );

    expect(response.status).toBe(200);
    const parsed = dashboardQueueRowsSchema.parse(response.body.data);
    if (parsed.queue !== "reviews") throw new Error("wrong queue");
    const ids = parsed.rows.map((row) => row.reviewId);
    expect(ids).toContain(atB.id);
    expect(ids).not.toContain(atA.id);
    expect(ids).not.toContain(foreign.id);
    expect(parsed.rows.every((row) => row.outletId === seededOutletB)).toBe(
      true,
    );
  });

  it("legend-vqicf a role without dashboard permission gets 403 on the reviews queue", async () => {
    const response = await queue(cashier);

    expect(response.status).toBe(403);
  });
});
