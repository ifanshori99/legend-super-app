// legend-7jrh7 (brief 1081): customer_reviews carries customer_profile_id, so it
// must get the same restrictive `member_self` policy as the other member tables
// (app.enforce_member_rls, GUC `app.customer_profile_id`). Today migration 0455
// forces tenant and outlet RLS but not member RLS: a member-scoped session can
// read and write the reviews of every other profile in the tenant.
//
// Written from the member RLS contract (member-isolation.test.ts, 0203 policy
// text: "member_self ... RESTRICTIVE ... IS NULL OR column = member profile"),
// not from the fix.
//
// Assumptions (each easy to change):
// - The policy is named `member_self`, RESTRICTIVE, FOR ALL, like the other member tables.
// - With a member profile set, a review with NULL customer_profile_id (anonymous
//   QR review) is NOT visible: NULL = id is not true. Restricts, never loosens.
// - Without the GUC (staff, NULL member context) nothing changes: every review
//   of the tenant stays readable and writable, NULL-profile reviews included.
// - Raw statements run as legend_app (SET LOCAL ROLE) inside a rolled-back
//   transaction; fixtures are written by the migration owner with the tenant GUCs.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorld,
  asTenant,
  owner,
  seedProfile,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

let world: World;
let profileA: string;
let profileB: string;
let reviewA: string;
let reviewB: string;
let reviewAnon: string;

async function insertReview(
  profileId: string | null,
  body: string,
): Promise<string> {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO customer_reviews
         (id, tenant_id, outlet_id, customer_profile_id, rating, body, source)
       VALUES ($1, $2, $3, $4, 5, $5, 'app')`,
      [id, world.tenantId, world.outletA, profileId, body],
    ),
  );
  return id;
}

/** legend_app with tenant GUCs; `member` null = no member context (staff). */
async function asApp<T>(
  member: string | null,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [world.tenantId],
    );
    if (member !== null)
      await client.query(
        "SELECT set_config('app.customer_profile_id', $1, true)",
        [member],
      );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const visibleIds = async (client: PoolClient) =>
  (
    await client.query<{ id: string }>(
      "SELECT id::text AS id FROM customer_reviews WHERE tenant_id = $1",
      [world.tenantId],
    )
  ).rows
    .map((row) => row.id)
    .sort();

beforeAll(async () => {
  world = await createWorld();
  profileA = (await seedProfile(world.tenantId)).id;
  profileB = (await seedProfile(world.tenantId)).id;
  reviewA = await insertReview(profileA, "ulasan A");
  reviewB = await insertReview(profileB, "ulasan B");
  reviewAnon = await insertReview(null, "ulasan anonim");
}, 60_000);

describe("legend-7jrh7 customer_reviews member RLS", () => {
  it("legend-7jrh7 customer_reviews has a restrictive member_self policy", async () => {
    const { rows } = await owner.query<{
      permissive: string;
      cmd: string;
      qual: string | null;
    }>(
      `SELECT permissive, cmd, qual FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'customer_reviews'
          AND policyname = 'member_self'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.permissive).toBe("RESTRICTIVE");
    expect(rows[0]!.cmd).toBe("ALL");
    expect(rows[0]!.qual).toMatch(/customer_profile_id/);
  });

  it("legend-7jrh7 tenant and outlet RLS stay forced next to member_self", async () => {
    const { rows } = await owner.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'customer_reviews'`,
    );
    const names = rows.map((row) => row.policyname);
    expect(names).toContain("member_self");
    expect(names.length).toBeGreaterThan(1);
    const { rows: flags } = await owner.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'public.customer_reviews'::regclass`,
    );
    expect(flags[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("legend-7jrh7 a member reads only their own reviews", async () => {
    const seenByA = await asApp(profileA, visibleIds);
    expect(seenByA).toEqual([reviewA]);
    expect(seenByA).not.toContain(reviewB);
    // Anonymous (NULL profile) reviews are not a member's to read.
    expect(seenByA).not.toContain(reviewAnon);
    const seenByB = await asApp(profileB, visibleIds);
    expect(seenByB).toEqual([reviewB]);
  });

  it("legend-7jrh7 a member cannot fetch another profile's review by id", async () => {
    await asApp(profileA, async (client) => {
      const { rows } = await client.query(
        "SELECT id FROM customer_reviews WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, reviewB],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("legend-7jrh7 a member cannot update another profile's review", async () => {
    await asApp(profileA, async (client) => {
      const result = await client.query(
        "UPDATE customer_reviews SET moderation_note = 'dibajak' WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, reviewB],
      );
      expect(result.rowCount).toBe(0);
    });
  });

  it("legend-7jrh7 a member cannot hand their own review to another profile", async () => {
    await asApp(profileA, async (client) => {
      await expect(
        client.query(
          "UPDATE customer_reviews SET customer_profile_id = $3 WHERE tenant_id = $1 AND id = $2",
          [world.tenantId, reviewA, profileB],
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("legend-7jrh7 a member cannot insert a review for another profile", async () => {
    await asApp(profileA, async (client) => {
      await expect(
        client.query(
          `INSERT INTO customer_reviews (tenant_id, outlet_id, customer_profile_id, rating, source)
           VALUES ($1, $2, $3, 4, 'app')`,
          [world.tenantId, world.outletA, profileB],
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("legend-7jrh7 a member can still insert and read back their own review", async () => {
    await asApp(profileA, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO customer_reviews (tenant_id, outlet_id, customer_profile_id, rating, source)
         VALUES ($1, $2, $3, 4, 'app') RETURNING id::text AS id`,
        [world.tenantId, world.outletA, profileA],
      );
      const id = inserted.rows[0]!.id;
      expect(await visibleIds(client)).toContain(id);
      const updated = await client.query(
        "UPDATE customer_reviews SET body = 'diubah' WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, id],
      );
      expect(updated.rowCount).toBe(1);
    });
  });

  it("legend-7jrh7 without a member context (NULL) staff still read every review of the tenant", async () => {
    const seen = await asApp(null, visibleIds);
    expect(seen).toEqual([reviewA, reviewB, reviewAnon].sort());
  });

  it("legend-7jrh7 an empty member context behaves like NULL", async () => {
    const seen = await asApp("", visibleIds);
    expect(seen).toEqual([reviewA, reviewB, reviewAnon].sort());
  });

  it("legend-7jrh7 without a member context staff can still moderate and insert", async () => {
    await asApp(null, async (client) => {
      const updated = await client.query(
        "UPDATE customer_reviews SET moderation_status = 'published' WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [world.tenantId, [reviewA, reviewB, reviewAnon]],
      );
      expect(updated.rowCount).toBe(3);
      const inserted = await client.query(
        `INSERT INTO customer_reviews (tenant_id, outlet_id, rating, source)
         VALUES ($1, $2, 3, 'manual')`,
        [world.tenantId, world.outletA],
      );
      expect(inserted.rowCount).toBe(1);
    });
  });
});
