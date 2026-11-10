// legend-111j: isolation of the new member / loyalty data (design M4; brief 290a
// "Tes gagal-dulu"): tenant RLS on every new table, member RLS (GUC
// `app.customer_profile_id`) on four tables, member-vs-member over HTTP, staff
// vs member routes, and the member route module's database entry point.
//
// Assumptions:
// - The member route module is `routes/member.routes.ts`; "imports withMemberScope
//   and not withTenant" is checked on its source text (any `withTenant` token fails).
// - A member session has no role assignment, so staff routes answer 403.
// - `member_profile_user_index` is not readable by legend_app (permission denied).
// - Query parameters naming another profile are ignored or rejected, never honored.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createUlid } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  memberTenantContext,
  withMemberScope,
  withProfileLock,
} from "../db/member-scope.ts";
import { postLedgerEntry } from "../services/point-ledger.service.ts";
import { originHeader } from "./helpers";
import { seededTenantId, staffWithRole } from "./floor-test-helpers";
import {
  NOW,
  asTenant,
  createWorld,
  deliver,
  ensureConsentPolicies,
  memberHeaders,
  newMemberUser,
  orderPaidEvent,
  owner,
  rejection,
  seedMember,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers.ts";

let app: Express;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  await seedProgram(seededTenantId);
});

afterAll(async () => {
  await owner.end();
});

/** A member with a paid order: profile, earn row, visit, record, consent. */
async function memberWithActivity(world: World) {
  const member = await seedMember(world.tenantId);
  const orderUlid = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: member.id,
  });
  await deliver(
    world,
    orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
  );
  return { member, orderUlid };
}

const TENANT_TABLES = [
  "loyalty_programs",
  "customer_profiles",
  "consent_policy_versions",
  "point_ledger",
  "point_earn_records",
  "customer_visits",
  "loyalty_anomalies",
] as const;

describe("TEN-01 tenant isolation of the new tables", () => {
  it("TEN-01 tenant B sees no row of tenant A in any new table", async () => {
    const a = await createWorld();
    const b = await createWorld();
    await seedProgram(a.tenantId);
    await seedProgram(b.tenantId);
    await memberWithActivity(a);
    await memberWithActivity(b);
    // Rows that only exist in A: a policy version and an anomaly.
    await asTenant(a.tenantId, async (client) => {
      await client.query(
        `INSERT INTO consent_policy_versions (tenant_id, purpose, version, text_hash, published_at)
         VALUES ($1, 'loyalty', '2026-01', $2, '2026-01-01T00:00:00+07:00')`,
        [a.tenantId, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO loyalty_anomalies (tenant_id, outlet_id, kind) VALUES ($1, $2, 'daily_cap_hit')`,
        [a.tenantId, a.outletA],
      );
    });

    for (const table of TENANT_TABLES) {
      const own = await withTenant(db, a.context, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${a.tenantId}`,
        ),
      );
      expect(
        Number(own.rows[0]!.n),
        `${table} visible to its own tenant`,
      ).toBeGreaterThan(0);
      const foreign = await withTenant(db, b.context, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${a.tenantId}`,
        ),
      );
      expect(Number(foreign.rows[0]!.n), `${table} leaked to tenant B`).toBe(0);
    }
  });

  it("TEN-01 tenant B cannot write a row for tenant A", async () => {
    const a = await createWorld();
    const b = await createWorld();
    await seedProgram(a.tenantId);
    await rejection(
      withTenant(db, b.context, (tx) =>
        tx.execute(sql`
          INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status)
          VALUES (${randomUUID()}, ${a.tenantId}, ${randomUUID()}, 'Penyusup', 'pending_verification')`),
      ),
    );
  });

  it("TEN-01 member_profile_user_index is not readable by the application role", async () => {
    const world = await createWorld();
    const message = await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(sql`SELECT * FROM member_profile_user_index`),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe("member RLS (GUC app.customer_profile_id)", () => {
  it("LOY-01 member RLS is enabled with a restrictive member_self policy on the four member tables", async () => {
    const { rows } = await owner.query<{
      tablename: string;
      permissive: string;
    }>(
      `SELECT tablename, permissive FROM pg_policies
        WHERE policyname = 'member_self'
          AND tablename = ANY($1::text[])`,
      [["customer_profiles", "point_ledger", "customer_visits", "consents"]],
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([
      "consents",
      "customer_profiles",
      "customer_visits",
      "point_ledger",
    ]);
    expect(rows.every((row) => row.permissive === "RESTRICTIVE")).toBe(true);
  });

  it("LOY-01 with the GUC set, a raw select of another member's rows is empty in all four tables", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const a = await memberWithActivity(world);
    const b = await memberWithActivity(world);
    const scope = {
      context: memberTenantContext(world.tenantId),
      tenantId: world.tenantId,
      userId: a.member.userId,
      customerProfileId: a.member.id,
      status: "active" as const,
    };
    const count = (query: ReturnType<typeof sql>) =>
      withMemberScope(db, scope, async (tx) =>
        Number((await tx.execute(query)).rows[0]!.n),
      );
    const bId = b.member.id;
    const aId = a.member.id;
    // Own rows are visible ...
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_profiles WHERE id = ${aId}`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM point_ledger WHERE customer_profile_id = ${aId}`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_visits WHERE customer_profile_id = ${aId}`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM consents WHERE subject_id = ${aId}`,
      ),
    ).toBeGreaterThan(0);
    // ... the other member's are not.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_profiles WHERE id = ${bId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM point_ledger WHERE customer_profile_id = ${bId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_visits WHERE customer_profile_id = ${bId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM consents WHERE subject_id = ${bId}`,
      ),
    ).toBe(0);
    // Without the GUC (staff context) both members are visible.
    const staffSees = await withTenant(db, world.context, async (tx) =>
      Number(
        (
          await tx.execute(
            sql`SELECT count(*)::int AS n FROM customer_profiles WHERE id IN (${aId}, ${bId})`,
          )
        ).rows[0]!.n,
      ),
    );
    expect(staffSees).toBe(2);
  });

  it("LOY-01 a member scope cannot insert a ledger row for another member", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const a = await seedMember(world.tenantId);
    const b = await seedMember(world.tenantId);
    const scope = {
      context: memberTenantContext(world.tenantId),
      tenantId: world.tenantId,
      userId: a.userId,
      customerProfileId: a.id,
      status: "active" as const,
    };
    await rejection(
      withMemberScope(db, scope, async (tx) => {
        await withProfileLock(tx, world.tenantId, b.id);
        return postLedgerEntry(
          tx,
          scope.context,
          {
            tenantId: world.tenantId,
            customerProfileId: b.id,
            type: "earn",
            points: 5,
            sourceType: "order",
            sourceId: createUlid(),
            expiresAt: new Date("2027-11-08T03:00:00Z"),
          },
          NOW,
        );
      }),
    );
  });
});

describe("member routes over HTTP", () => {
  /** Posts an earn row for a seeded-tenant profile as the app role. */
  async function earnFor(profileId: string, points: number) {
    const context = memberTenantContext(seededTenantId);
    await withTenant(db, context, async (tx) => {
      await withProfileLock(tx, seededTenantId, profileId);
      await postLedgerEntry(
        tx,
        context,
        {
          tenantId: seededTenantId,
          customerProfileId: profileId,
          type: "earn",
          points,
          sourceType: "order",
          sourceId: createUlid(),
          expiresAt: new Date("2027-11-08T03:00:00Z"),
        },
        NOW,
      );
    });
  }

  it("LOY-01 member A reads only their own profile and points, never B's, even when naming B", async () => {
    const a = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const b = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await earnFor(a.profileId!, 11);
    await earnFor(b.profileId!, 22);

    const ownProfile = await a.client
      .get("/api/member/profile")
      .set(memberHeaders);
    expect(ownProfile.status).toBe(200);
    expect(ownProfile.body.data.id).toBe(a.profileId);
    expect(ownProfile.body.data.pointsBalance).toBe(11);
    expect(JSON.stringify(ownProfile.body)).not.toContain(b.profileId!);

    const ownPoints = await a.client
      .get("/api/member/points")
      .set(memberHeaders);
    expect(ownPoints.status).toBe(200);
    expect(
      (
        ownPoints.body.data as { customerProfileId: string; points: number }[]
      ).map((row) => [row.customerProfileId, row.points]),
    ).toEqual([[a.profileId, 11]]);

    // Naming B in the query, path or body never changes whose data is returned.
    const named = await a.client
      .get(`/api/member/points?customerProfileId=${b.profileId}`)
      .set(memberHeaders);
    expect([200, 400, 422]).toContain(named.status);
    expect(JSON.stringify(named.body)).not.toContain(b.profileId!);
    const foreignPath = await a.client
      .get(`/api/member/${b.profileId}/points`)
      .set(memberHeaders);
    expect([404, 405]).toContain(foreignPath.status);
    expect(JSON.stringify(foreignPath.body)).not.toContain(b.profileId!);

    const bPoints = await b.client.get("/api/member/points").set(memberHeaders);
    expect(
      (bPoints.body.data as { points: number }[]).map((row) => row.points),
    ).toEqual([22]);
  });

  it("LOY-01 a member session gets 403 on staff routes", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    for (const path of [
      "/api/loyalty/program",
      "/api/loyalty/anomalies",
      `/api/customers/${member.profileId}/points`,
    ]) {
      const response = await member.client.get(path).set(memberHeaders);
      expect(response.status, path).toBe(403);
    }
    const put = await member.client
      .put("/api/loyalty/program")
      .set(memberHeaders)
      .set(originHeader)
      .send({});
    expect(put.status).toBe(403);
    const attach = await member.client
      .put(`/api/pos/orders/${createUlid()}/customer`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ customerProfileId: null });
    // The order is resolved before its outlet can be authorized, so an unknown
    // order may answer 404; a member never gets 2xx.
    expect([403, 404]).toContain(attach.status);
  });

  it("LOY-01 a staff user without a profile gets 404 CUSTOMER_NOT_FOUND on member routes", async () => {
    const staff = await staffWithRole(app, {
      template: "owner",
      label: "Owner Tanpa Profil",
    });
    for (const path of ["/api/member/profile", "/api/member/points"]) {
      const response = await staff.client.get(path).set(memberHeaders);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe("CUSTOMER_NOT_FOUND");
    }
  });

  it("LOY-01 the member route module reaches the database through withMemberScope, never withTenant", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Comments may mention the names; only code counts.
    const source = readFileSync(
      resolve(here, "../routes/member.routes.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).toMatch(/\bwithMemberScope\b/);
    expect(source).not.toMatch(/\bwithTenant\b/);
  });
});
