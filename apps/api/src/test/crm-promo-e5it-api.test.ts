// Per-outlet promotion switch API (contract listPromotionOutlets /
// setPromotionOutlet; PRD v1.7 §3.21; TEN-01..03; bead legend-e5it). Runs
// the real Express app, Better Auth, the RBAC resolver and PostgreSQL.
//
// Isolation: files share the seeded tenant; promotions here stay drafts, so
// no checkout in another file ever sees them.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet, secondOutlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdPromotions: string[] = [];

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

/** A custom role with exactly the given catalog codes. */
async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `E5IT test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function marketing() {
  const user = await signedInClient("E5IT Marketing");
  await grantRole(user.userId, ["promo.manage"], { type: "tenant" });
  return user;
}

type Client_ = Awaited<ReturnType<typeof signedInClient>>["client"];

async function draftPromotion(client: Client_): Promise<string> {
  const response = await client
    .post("/api/promotions")
    .set(originHeader)
    .send({
      name: "Promo Outlet Uji",
      description: "",
      status: "draft",
      codeHash: null,
      voucherRequired: false,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      endsAt: null,
      conditions: [],
      benefit: { kind: "percent_off", percentBp: 500, maxDiscountIdr: null },
      stackGroup: "uji",
      stackable: true,
      priority: 0,
      quotaTotal: null,
      quotaPerCustomer: null,
      budgetIdr: null,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const id = response.body.data.id as string;
  createdPromotions.push(id);
  return id;
}

afterAll(async () => {
  await owner.query(
    `DELETE FROM promotion_outlets WHERE tenant_id = $1 AND promotion_id = ANY($2)`,
    [tenant.id, createdPromotions],
  );
  if (createdPromotions.length > 0)
    await owner.query(
      "UPDATE promotions SET status = 'ended' WHERE id = ANY($1)",
      [createdPromotions],
    );
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'E5IT test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("E5IT per-outlet promotion switch API", () => {
  it("[E5IT-3] lists every outlet as enabled by default, switches one off, audits it and emits promotion_outlet.changed", async () => {
    const { client } = await marketing();
    const promotionId = await draftPromotion(client);

    const before = await client.get(`/api/promotions/${promotionId}/outlets`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const outletIds = before.body.data.map(
      (row: { outletId: string }) => row.outletId,
    );
    expect(outletIds).toEqual(
      expect.arrayContaining([outlet.id, secondOutlet.id]),
    );
    expect(
      before.body.data.every((row: { enabled: boolean }) => row.enabled),
    ).toBe(true);

    const set = await client
      .put(`/api/promotions/${promotionId}/outlets/${outlet.id}`)
      .set(originHeader)
      .send({ enabled: false });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toEqual({
      promotionId,
      tenantId: tenant.id,
      outletId: outlet.id,
      enabled: false,
    });
    // Repeating the same switch is idempotent (no second event/audit).
    const again = await client
      .put(`/api/promotions/${promotionId}/outlets/${outlet.id}`)
      .set(originHeader)
      .send({ enabled: false });
    expect(again.status).toBe(200);

    const after = await client.get(`/api/promotions/${promotionId}/outlets`);
    const state = Object.fromEntries(
      after.body.data.map((row: { outletId: string; enabled: boolean }) => [
        row.outletId,
        row.enabled,
      ]),
    );
    expect(state[outlet.id]).toBe(false);
    expect(state[secondOutlet.id]).toBe(true);

    const audit = await owner.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'promotion_outlet.changed'
          AND event->>'objectId' = $2`,
      [tenant.id, promotionId],
    );
    expect(audit.rows[0].n).toBe(1);
    const events = await owner.query(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'promotion_outlet.changed'
          AND event->'payload'->>'promotionId' = $2`,
      [tenant.id, promotionId],
    );
    expect(events.rows).toEqual([
      { payload: { promotionId, outletId: outlet.id, enabled: false } },
    ]);
  });

  it("[E5IT-3] TEN-03: an outlet-scoped promo.manage role switches its own outlet only and cannot list the tenant", async () => {
    const admin = await marketing();
    const promotionId = await draftPromotion(admin.client);
    const local = await signedInClient("E5IT Outlet Manager");
    await grantRole(local.userId, ["promo.manage"], {
      type: "outlet",
      id: outlet.id,
    });
    const own = await local.client
      .put(`/api/promotions/${promotionId}/outlets/${outlet.id}`)
      .set(originHeader)
      .send({ enabled: false });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const other = await local.client
      .put(`/api/promotions/${promotionId}/outlets/${secondOutlet.id}`)
      .set(originHeader)
      .send({ enabled: false });
    expect(other.status).toBe(403);
    expect(
      (await local.client.get(`/api/promotions/${promotionId}/outlets`)).status,
    ).toBe(403);
  });

  it("[E5IT-3] refuses callers without promo.manage, anonymous callers, foreign origins, tenant ids in the body and unknown or foreign promotions", async () => {
    const admin = await marketing();
    const promotionId = await draftPromotion(admin.client);
    const cashier = await signedInClient("E5IT Kasir");
    await grantRole(cashier.userId, ["order.create"], { type: "tenant" });
    expect(
      (
        await cashier.client
          .put(`/api/promotions/${promotionId}/outlets/${outlet.id}`)
          .set(originHeader)
          .send({ enabled: false })
      ).status,
    ).toBe(403);
    expect(
      (await cashier.client.get(`/api/promotions/${promotionId}/outlets`))
        .status,
    ).toBe(403);
    expect(
      (await agent(app).get(`/api/promotions/${promotionId}/outlets`)).status,
    ).toBe(401);
    expect(
      (
        await admin.client
          .put(`/api/promotions/${promotionId}/outlets/${outlet.id}`)
          .send({ enabled: false })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.client
          .put(`/api/promotions/${promotionId}/outlets/${outlet.id}`)
          .set(originHeader)
          .send({ enabled: false, tenantId: tenant.id })
      ).status,
    ).toBe(422);
    // Unknown (or another tenant's — RLS hides it) promotion: 404.
    const unknown = randomUUID();
    expect(
      (await admin.client.get(`/api/promotions/${unknown}/outlets`)).status,
    ).toBe(404);
    expect(
      (
        await admin.client
          .put(`/api/promotions/${unknown}/outlets/${outlet.id}`)
          .set(originHeader)
          .send({ enabled: false })
      ).status,
    ).toBe(404);
    // An outlet outside the tenant is denied before the service runs.
    const foreign = await admin.client
      .put(`/api/promotions/${promotionId}/outlets/${randomUUID()}`)
      .set(originHeader)
      .send({ enabled: false });
    expect([403, 404]).toContain(foreign.status);
  });
});
