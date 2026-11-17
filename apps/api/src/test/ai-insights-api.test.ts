// AI insights HTTP API (WS-12 wave 3, part R; beads legend-hkd4, legend-lely).
// Real Express app, Better Auth, RBAC resolver and PostgreSQL against the
// seeded Cafe Legend tenant. Covers 401, 403 without the permission, outlet
// reach (cross-outlet denial) and cross-tenant isolation. The LLM drafts are
// covered in ai-drafts.test.ts; here only the gates and body validation.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  app,
  asTenant,
  cleanupAcceptance,
  grantCustomRole,
  originHeader,
  outletA,
  outletB,
  ownerPool,
  signedIn,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";
import { agent } from "./helpers.ts";

const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const alertA = randomUUID();
const alertB = randomUUID();
const forecastA = randomUUID();
const forecastB = randomUUID();
const summaryA = randomUUID();
const summaryB = randomUUID();
const DAY = "2026-11-10";

let manager: Actor; // tenant-wide, every insights permission
let outletOnly: Actor; // outlet A only, every insights permission
let asker: Actor; // ai.ask only
let nobody: Actor;

const READ_PERMISSIONS = [
  "report.sales.view",
  "report.operational.view",
  "inventory.stock.view",
  "hr.schedule.manage",
];
const DRAFT_PERMISSIONS = [
  "ai.ask",
  "promo.manage",
  "accounting.expense.request",
];

function getPaths(outletId: string) {
  return [
    `/api/ai/forecasts?outletId=${outletId}&from=${DAY}&to=${DAY}`,
    `/api/ai/purchase-suggestions?outletId=${outletId}`,
    `/api/ai/roster-inputs?outletId=${outletId}&date=${DAY}`,
    `/api/ai/anomalies?outletId=${outletId}`,
    `/api/ai/daily-summaries?outletId=${outletId}`,
  ];
}

const postBodies: [string, unknown][] = [
  [
    "/api/ai/drafts/promo-copy",
    { kind: "banner", brief: "Promo kopi susu akhir pekan" },
  ],
  ["/api/ai/drafts/expense-account", { description: "Beli gas LPG dapur" }],
  [`/api/ai/anomalies/${randomUUID()}/acknowledge`, {}],
];

beforeAll(async () => {
  manager = await signedIn("Insights manager");
  await grantCustomRole(
    manager.userId,
    [...READ_PERMISSIONS, ...DRAFT_PERMISSIONS],
    { type: "tenant" },
  );
  outletOnly = await signedIn("Insights outlet");
  await grantCustomRole(
    outletOnly.userId,
    [...READ_PERMISSIONS, ...DRAFT_PERMISSIONS],
    { type: "outlet", id: outletA },
  );
  asker = await signedIn("Insights asker");
  await grantCustomRole(asker.userId, ["ai.ask"], { type: "tenant" });
  nobody = await signedIn("Insights nobody");

  await ownerPool.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Insights other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `ai-ins-${otherTenant.slice(0, 8)}`, tenantId],
  );
  const asOther = async (
    run: (db: import("pg").PoolClient) => Promise<void>,
  ) => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [otherTenant],
      );
      await run(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  await asOther(async (db) => {
    await db.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
    await db.query(
      `INSERT INTO forecasts (id, tenant_id, outlet_id, target_date, hour, metric_code, value, model_version, generated_at)
       VALUES ($1, $2, $3, $4, 12, 'sales_idr', 999, 'rule-v1', now())`,
      [forecastB, otherTenant, otherOutlet, DAY],
    );
    await db.query(
      `INSERT INTO ai_anomaly_alerts (id, tenant_id, outlet_id, business_date, kind, observed_idr, baseline_idr, ratio, severity)
       VALUES ($1, $2, $3, $4, 'void', 500000, 100000, 5, 'high')`,
      [alertB, otherTenant, otherOutlet, DAY],
    );
    await db.query(
      `INSERT INTO ai_daily_summaries (id, tenant_id, outlet_id, business_date, text, ai_assisted, metrics)
       VALUES ($1, $2, $3, $4, 'Ringkasan lain.', false, '{}'::jsonb)`,
      [summaryB, otherTenant, otherOutlet, DAY],
    );
  });
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO forecasts (id, tenant_id, outlet_id, target_date, hour, metric_code, value, model_version, generated_at)
       VALUES ($1, $2, $3, $4, 12, 'sales_idr', 150000, 'rule-v1', now())`,
      [forecastA, tenantId, outletA, DAY],
    );
    await db.query(
      `INSERT INTO ai_anomaly_alerts (id, tenant_id, outlet_id, business_date, kind, observed_idr, baseline_idr, ratio, severity)
       VALUES ($1, $2, $3, $4, 'void', 300000, 100000, 3, 'high')`,
      [alertA, tenantId, outletA, DAY],
    );
    await db.query(
      `INSERT INTO ai_daily_summaries (id, tenant_id, outlet_id, business_date, text, ai_assisted, metrics)
       VALUES ($1, $2, $3, $4, 'Ringkasan uji.', false,
               '{"salesIdr":1,"orders":1,"voidIdr":0,"discountIdr":0,"refundIdr":0,"wasteIdr":0}'::jsonb)`,
      [summaryA, tenantId, outletA, DAY],
    );
  });
});

afterAll(async () => {
  for (const table of ["forecasts", "ai_anomaly_alerts", "ai_daily_summaries"])
    await ownerPool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
      [tenantId, otherTenant],
    ]);
  await ownerPool.query(`DELETE FROM outlets WHERE tenant_id = $1`, [
    otherTenant,
  ]);
  await ownerPool.query(`DELETE FROM legal_entities WHERE tenant_id = $1`, [
    otherTenant,
  ]);
  await ownerPool.query(`DELETE FROM brands WHERE tenant_id = $1`, [
    otherTenant,
  ]);
  await ownerPool.query(`DELETE FROM tenants WHERE id = $1`, [otherTenant]);
  await cleanupAcceptance();
  await ownerPool.end();
});

describe("auth", () => {
  it("returns 401 for every route without a session", async () => {
    for (const path of getPaths(outletA))
      expect((await agent(app).get(path)).status, path).toBe(401);
    for (const [path, body] of postBodies)
      expect(
        (
          await agent(app)
            .post(path)
            .set(originHeader)
            .send(body as object)
        ).status,
        path,
      ).toBe(401);
  });

  it("rejects a foreign origin on POST", async () => {
    const res = await manager.client
      .post("/api/ai/drafts/promo-copy")
      .set({ Origin: "https://evil.example" })
      .send({ kind: "banner", brief: "x" });
    expect(res.status).toBe(403);
  });
});

describe("403 without the permission", () => {
  it("denies a user with no insights permission on every GET", async () => {
    for (const actor of [asker, nobody])
      for (const path of getPaths(outletA))
        expect((await actor.client.get(path)).status, path).toBe(403);
  });

  it("denies the drafts without the permission or without ai.ask", async () => {
    for (const actor of [asker, nobody]) {
      for (const [path, body] of postBodies.slice(0, 2))
        expect(
          (
            await actor.client
              .post(path)
              .set(originHeader)
              .send(body as object)
          ).status,
          path,
        ).toBe(403);
    }
    // Insights read permissions but no ai.ask: drafts stay closed.
    const noAsk = await signedIn("Insights no ask");
    await grantCustomRole(noAsk.userId, ["promo.manage"], { type: "tenant" });
    const res = await noAsk.client
      .post("/api/ai/drafts/promo-copy")
      .set(originHeader)
      .send({ kind: "banner", brief: "Promo" });
    expect(res.status).toBe(403);
  });

  it("denies acknowledging an alert without report.operational.view", async () => {
    const res = await asker.client
      .post(`/api/ai/anomalies/${alertA}/acknowledge`)
      .set(originHeader)
      .send({});
    expect(res.status).toBe(403);
    const row = await ownerPool.query(
      `SELECT status FROM ai_anomaly_alerts WHERE id = $1`,
      [alertA],
    );
    expect(row.rows[0].status).toBe("open");
  });
});

describe("outlet reach", () => {
  it("lets an outlet-scoped holder read its own outlet", async () => {
    for (const path of getPaths(outletA))
      expect((await outletOnly.client.get(path)).status, path).toBe(200);
  });

  it("denies another outlet of the same tenant on every GET", async () => {
    for (const path of getPaths(outletB))
      expect((await outletOnly.client.get(path)).status, path).toBe(403);
  });

  it("allows a tenant-wide holder on both outlets", async () => {
    for (const outlet of [outletA, outletB])
      for (const path of getPaths(outlet))
        expect((await manager.client.get(path)).status, path).toBe(200);
  });
});

describe("validation", () => {
  it("accepts bounded suggestion pagination and rejects invalid bounds", async () => {
    const path = `/api/ai/purchase-suggestions?outletId=${outletA}`;
    const result = await manager.client.get(`${path}&limit=1&offset=0`);
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.data)).toBe(true);
    expect(result.body.data.length).toBeLessThanOrEqual(1);
    for (const query of ["limit=101", "limit=0", "limit=1.5", "offset=-1"])
      expect((await manager.client.get(`${path}&${query}`)).status).toBe(422);
  });

  it("rejects missing or malformed query with 422", async () => {
    for (const path of [
      "/api/ai/forecasts",
      `/api/ai/forecasts?outletId=not-a-uuid&from=${DAY}&to=${DAY}`,
      `/api/ai/forecasts?outletId=${outletA}&from=2026-11-01&to=2026-12-31`,
      `/api/ai/forecasts?outletId=${outletA}&from=${DAY}&to=${DAY}&metricCode=bogus`,
      "/api/ai/purchase-suggestions",
      `/api/ai/roster-inputs?outletId=${outletA}`,
      `/api/ai/daily-summaries`,
    ])
      expect((await manager.client.get(path)).status, path).toBe(422);
  });

  it("rejects bad draft bodies with 422", async () => {
    for (const [path, body] of [
      ["/api/ai/drafts/promo-copy", {}],
      ["/api/ai/drafts/promo-copy", { kind: "poster", brief: "x" }],
      ["/api/ai/drafts/promo-copy", { kind: "banner", brief: "x".repeat(501) }],
      ["/api/ai/drafts/expense-account", {}],
      ["/api/ai/drafts/expense-account", { description: "x", unknown: 1 }],
    ] as [string, object][])
      expect(
        (await manager.client.post(path).set(originHeader).send(body)).status,
        JSON.stringify(body),
      ).toBe(422);
  });
});

describe("data and cross-tenant isolation", () => {
  it("returns tenant A rows only", async () => {
    const forecasts = await manager.client.get(getPaths(outletA)[0]!);
    expect(forecasts.status).toBe(200);
    expect(forecasts.headers["cache-control"]).toBe("private, no-store");
    const ids = (forecasts.body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(forecastA);
    expect(ids).not.toContain(forecastB);

    const alerts = await manager.client.get(getPaths(outletA)[3]!);
    const alertIds = (alerts.body.data as { id: string }[]).map((r) => r.id);
    expect(alertIds).toContain(alertA);
    expect(alertIds).not.toContain(alertB);

    const summaries = await manager.client.get(getPaths(outletA)[4]!);
    const summaryIds = (summaries.body.data as { id: string }[]).map(
      (r) => r.id,
    );
    expect(summaryIds).toContain(summaryA);
    expect(summaryIds).not.toContain(summaryB);
  });

  it("never exposes another tenant's outlet", async () => {
    for (const path of getPaths(otherOutlet)) {
      const res = await manager.client.get(path);
      // Denied outright, or an empty answer: never the other tenant's rows.
      expect([200, 403, 404], path).toContain(res.status);
      if (res.status === 200) {
        const text = JSON.stringify(res.body);
        for (const id of [forecastB, alertB, summaryB])
          expect(text).not.toContain(id);
      }
    }
  });

  it("filters alerts by outlet and status", async () => {
    const res = await manager.client.get(
      `/api/ai/anomalies?outletId=${outletA}&status=acknowledged&from=${DAY}&to=${DAY}`,
    );
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((r) => r.id)).not.toContain(
      alertA,
    );
  });

  it("acknowledges an alert, and cannot touch another tenant's alert", async () => {
    const foreign = await manager.client
      .post(`/api/ai/anomalies/${alertB}/acknowledge`)
      .set(originHeader)
      .send({});
    expect([403, 404]).toContain(foreign.status);
    const untouched = await ownerPool.query(
      `SELECT status FROM ai_anomaly_alerts WHERE id = $1`,
      [alertB],
    );
    expect(untouched.rows[0].status).toBe("open");

    const denied = await outletOnly.client
      .post(`/api/ai/anomalies/${randomUUID()}/acknowledge`)
      .set(originHeader)
      .send({});
    expect(denied.status).toBe(404);

    const ok = await manager.client
      .post(`/api/ai/anomalies/${alertA}/acknowledge`)
      .set(originHeader)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      id: alertA,
      status: "acknowledged",
    });
  });
});
