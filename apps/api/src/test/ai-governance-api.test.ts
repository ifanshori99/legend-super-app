// AI governance + usage HTTP API (PRD v1.7 §3 Fitur 40, AIG-01..04; bead
// legend-zfi4). Real Express app, Better Auth, RBAC resolver and PostgreSQL
// against the seeded Cafe Legend tenant; users hold real role assignments.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `AI gov api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
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
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let admin: Client;
let adminId: string;
let asker: Client;
let outletAsker: Client;
let nobody: Client;

async function resetSettings() {
  await owner.query(`DELETE FROM ai_settings WHERE tenant_id = $1`, [
    tenant.id,
  ]);
}

beforeAll(async () => {
  const a = await signedInClient("AI admin");
  await grantRole(a.userId, ["ai.governance.manage", "ai.ask"], {
    type: "tenant",
  });
  admin = a.client;
  adminId = a.userId;
  const b = await signedInClient("AI asker");
  await grantRole(b.userId, ["ai.ask"], { type: "tenant" });
  asker = b.client;
  const c = await signedInClient("AI outlet asker");
  await grantRole(c.userId, ["ai.ask"], { type: "outlet", id: outlet.id });
  outletAsker = c.client;
  nobody = (await signedInClient("AI nobody")).client;
  await resetSettings();
});

const tenantB = randomUUID();
const clientRowId = randomUUID();
const otherUser = randomUUID();

afterAll(async () => {
  await resetSettings();
  for (const table of ["ai_tool_calls", "ai_usage_events", "ai_usage_monthly"])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
      [tenant.id, tenantB],
    ]);
  await owner.query(`DELETE FROM mcp_clients WHERE tenant_id = $1`, [
    tenant.id,
  ]);
  await owner.query(`DELETE FROM tenants WHERE id = $1`, [tenantB]);
  await owner.query(`DELETE FROM role_assignments WHERE role_id = ANY($1)`, [
    createdRoles,
  ]);
  await owner.query(`DELETE FROM roles WHERE id = ANY($1)`, [createdRoles]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1)`, [
    [...createdUsers, otherUser],
  ]);
  await owner.end();
});

describe("GET /api/ai/governance", () => {
  it("[AIG-01] needs ai.governance.manage", async () => {
    expect((await asker.get("/api/ai/governance")).status).toBe(403);
    expect((await nobody.get("/api/ai/governance")).status).toBe(403);
    expect((await agent(app).get("/api/ai/governance")).status).toBe(401);
  });

  it("returns fail-closed defaults when nothing is saved", async () => {
    const res = await admin.get("/api/ai/governance");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tenantId: tenant.id,
      aiEnabled: true,
      mcpEnabled: false,
      dynamicClientRegistrationEnabled: false,
      monthlyBudgetIdr: 0,
      budgetWarnPct: 80,
      budgetStopPct: 100,
      features: [],
      disabledToolCodes: [],
    });
  });
});

describe("PATCH /api/ai/governance", () => {
  it("rejects callers without the permission, a foreign origin and bad bodies", async () => {
    expect(
      (
        await asker
          .patch("/api/ai/governance")
          .set(originHeader)
          .send({ aiEnabled: false })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin
          .patch("/api/ai/governance")
          .set({ Origin: "https://evil.example" })
          .send({ aiEnabled: false })
      ).status,
    ).toBe(403);
    for (const body of [
      {},
      { tenantId: randomUUID() },
      { monthlyBudgetIdr: -1 },
      { budgetWarnPct: 90, budgetStopPct: 80 },
      { disabledToolCodes: ["TL-01", "TL-01"] },
      { unknown: 1 },
    ]) {
      const res = await admin
        .patch("/api/ai/governance")
        .set(originHeader)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("saves a partial update, audits it and appends the event", async () => {
    const res = await admin
      .patch("/api/ai/governance")
      .set(originHeader)
      .send({
        monthlyBudgetIdr: 500_000,
        mcpEnabled: true,
        disabledToolCodes: ["TL-13"],
        features: [
          {
            feature: "AI-01",
            isEnabled: true,
            dailyLimitByRole: { employee: 10 },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      monthlyBudgetIdr: 500_000,
      mcpEnabled: true,
      aiEnabled: true,
      disabledToolCodes: ["TL-13"],
      updatedBy: adminId,
    });
    const get = await admin.get("/api/ai/governance");
    expect(get.body.data.features).toEqual([
      { feature: "AI-01", isEnabled: true, dailyLimitByRole: { employee: 10 } },
    ]);
    const audit = await owner.query(
      `SELECT event -> 'maskedChanges' -> 'after' AS after FROM audit_logs
        WHERE tenant_id = $1 AND event ->> 'action' = 'ai_settings.updated' ORDER BY event ->> 'createdAt' DESC, id DESC LIMIT 1`,
      [tenant.id],
    );
    expect(audit.rows[0].after).toMatchObject({
      monthlyBudgetIdr: 500_000,
      mcpEnabled: true,
    });
    const outbox = await owner.query(
      `SELECT event -> 'payload' -> 'changedFields' AS fields FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'ai_settings' ORDER BY sequence DESC, id DESC LIMIT 1`,
      [tenant.id],
    );
    expect(outbox.rows[0].fields).toEqual(
      expect.arrayContaining([
        "monthlyBudgetIdr",
        "mcpEnabled",
        "disabledToolCodes",
        "features",
      ]),
    );
  });

  it("validates warn < stop against the STORED value when only one is sent", async () => {
    await admin
      .patch("/api/ai/governance")
      .set(originHeader)
      .send({ budgetWarnPct: 60, budgetStopPct: 90 });
    const res = await admin
      .patch("/api/ai/governance")
      .set(originHeader)
      .send({ budgetWarnPct: 95 });
    expect(res.status).toBe(422);
    const ok = await admin
      .patch("/api/ai/governance")
      .set(originHeader)
      .send({ budgetWarnPct: 70 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      budgetWarnPct: 70,
      budgetStopPct: 90,
    });
  });

  it("an update that changes nothing writes no audit row or event", async () => {
    const count = async () =>
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event ->> 'action' = 'ai_settings.updated'`,
          [tenant.id],
        )
      ).rows[0].n as number;
    const before = await count();
    const res = await admin
      .patch("/api/ai/governance")
      .set(originHeader)
      .send({ budgetWarnPct: 70 });
    expect(res.status).toBe(200);
    expect(await count()).toBe(before);
  });
});

describe("GET /api/ai/usage", () => {
  it("[AIG-01] needs ai.ask; any scope of it is enough", async () => {
    expect((await nobody.get("/api/ai/usage")).status).toBe(403);
    expect((await agent(app).get("/api/ai/usage")).status).toBe(401);
    expect((await outletAsker.get("/api/ai/usage")).status).toBe(200);
  });

  it("shows the caller's own quota and hides tenant spend without ai.governance.manage", async () => {
    const res = await asker.get("/api/ai/usage");
    expect(res.status).toBe(200);
    expect(res.body.data.budget).toBeNull();
    expect(res.body.data.aiEnabled).toBe(true);
    expect(res.body.data.month).toMatch(/^\d{4}-\d{2}$/);
    expect(res.body.data.features).toHaveLength(14);
    expect(res.body.data.features[0]).toMatchObject({
      feature: "AI-01",
      usedToday: 0,
    });
  });

  it("shows the tenant budget to the governance admin", async () => {
    const res = await admin.get("/api/ai/usage");
    expect(res.status).toBe(200);
    expect(res.body.data.budget).toMatchObject({
      monthlyBudgetIdr: 500_000,
      usedIdr: 0,
      warnPct: 70,
      stopPct: 90,
      state: "ok",
    });
    const limit = res.body.data.features.find(
      (f: { feature: string }) => f.feature === "AI-01",
    );
    expect(limit.dailyLimit).toBeGreaterThan(0);
  });
});

// ---- tools list, tenant usage and tool-call audit ---------------------------

const callIds: string[] = [];
const thisMonth = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);

async function seedCall(
  tenantId: string,
  userId: string,
  p: {
    tool: string;
    channel?: "app" | "mcp";
    status?: string;
    errorCode?: string | null;
    createdAt: string;
    params?: Record<string, unknown>;
    mcp?: boolean;
  },
) {
  const id = createUlid(new Date(p.createdAt).getTime());
  callIds.push(id);
  await owner.query(
    `INSERT INTO ai_tool_calls (id, tenant_id, tool_code, channel, user_id, mcp_client_id, params,
       status, row_count, duration_ms, error_code, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 3, 12, $9, $10)`,
    [
      ulidToUuid(id),
      tenantId,
      p.tool,
      p.channel ?? "app",
      userId,
      p.mcp ? clientRowId : null,
      JSON.stringify(p.params ?? {}),
      p.status ?? "ok",
      p.errorCode ?? null,
      p.createdAt,
    ],
  );
  return id;
}

describe("tools, tenant usage and tool-call audit", () => {
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'AI gov other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenantB, `ai-gov-${tenantB.slice(0, 8)}`, tenant.id],
    );
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'AI other', $2)`,
      [otherUser, `${otherUser}@example.test`],
    );
    await owner.query(
      `INSERT INTO mcp_clients (id, tenant_id, name, client_id, redirect_uris, allowed_scopes, registered_via)
       VALUES ($1, $2, 'Fixture', $3, ARRAY['https://example.test/cb'], ARRAY['mcp:sales:read'], 'admin')`,
      [clientRowId, tenant.id, `client-${clientRowId}`],
    );
    const now = new Date().toISOString();
    // Tenant A: month activity.
    await seedCall(tenant.id, adminId, {
      tool: "TL-01",
      createdAt: "2026-03-01T03:00:00Z",
      params: { period: "today", nested: { a: 1 } },
    });
    await seedCall(tenant.id, adminId, {
      tool: "TL-02",
      createdAt: "2026-03-01T03:00:01Z",
      status: "denied",
      errorCode: "AI_TOOL_FORBIDDEN",
    });
    await seedCall(tenant.id, adminId, {
      tool: "TL-03",
      createdAt: "2026-03-01T03:00:02Z",
      status: "denied",
      errorCode: "AI_TOOL_DISABLED",
    });
    await seedCall(tenant.id, adminId, {
      tool: "TL-04",
      createdAt: "2026-03-01T03:00:03Z",
      channel: "mcp",
      mcp: true,
      status: "denied",
      errorCode: "MCP_RATE_LIMITED",
    });
    await seedCall(tenant.id, adminId, {
      tool: "TL-05",
      createdAt: "2026-03-01T03:00:04Z",
      status: "error",
      errorCode: "INTERNAL",
    });
    await seedCall(tenant.id, adminId, {
      tool: "TL-06",
      createdAt: now,
      channel: "mcp",
      mcp: true,
    });
    // Tenant B: must never show up for tenant A's admin.
    await seedCall(tenantB, otherUser, { tool: "TL-07", createdAt: now });
    const event = (
      tenantId: string,
      userId: string,
      feature: string,
      status: string,
      code: string | null,
      at: string,
      tokens = 0,
      idr = 0,
    ) =>
      owner.query(
        `INSERT INTO ai_usage_events (tenant_id, user_id, feature, channel, provider, model, status, error_code,
           input_tokens, output_tokens, cost_idr, created_at)
         VALUES ($1, $2, $3, 'tanya_ai', 'fake', 'fake-1', $4, $5, $6, $6, $7, $8)`,
        [tenantId, userId, feature, status, code, tokens, idr, at],
      );
    await event(
      tenant.id,
      adminId,
      "AI-01",
      "ok",
      null,
      "2026-03-10T03:00:00Z",
      100,
      40,
    );
    await event(
      tenant.id,
      adminId,
      "AI-01",
      "ok",
      null,
      "2026-03-11T03:00:00Z",
      200,
      60,
    );
    await event(
      tenant.id,
      adminId,
      "AI-01",
      "blocked",
      "AI_QUOTA_EXCEEDED",
      "2026-03-12T03:00:00Z",
    );
    await event(
      tenant.id,
      adminId,
      "AI-02",
      "blocked",
      "AI_PII_BLOCKED",
      "2026-03-12T03:00:00Z",
    );
    await event(
      tenant.id,
      adminId,
      "AI-01",
      "ok",
      null,
      "2026-04-01T03:00:00Z",
      999,
      999,
    ); // other month
    await event(
      tenantB,
      otherUser,
      "AI-01",
      "ok",
      null,
      "2026-03-10T03:00:00Z",
      5000,
      5000,
    );
    await owner.query(
      `INSERT INTO ai_usage_monthly (tenant_id, usage_month, cost_idr, cost_micro_usd) VALUES ($1, '2026-03', 100, 6000)`,
      [tenant.id],
    );
  });

  describe("GET /api/ai/governance/tools", () => {
    it("[AIG-01] needs ai.governance.manage", async () => {
      expect((await asker.get("/api/ai/governance/tools")).status).toBe(403);
      expect((await agent(app).get("/api/ai/governance/tools")).status).toBe(
        401,
      );
    });

    it("lists the whole catalog with the kill-switch state", async () => {
      const res = await admin.get("/api/ai/governance/tools");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(21);
      const byCode = Object.fromEntries(
        res.body.data.map((t: { code: string; isEnabled: boolean }) => [
          t.code,
          t.isEnabled,
        ]),
      );
      expect(byCode["TL-13"]).toBe(false);
      expect(byCode["TL-01"]).toBe(true);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          code: "TL-01",
          name: expect.any(String),
          titleId: expect.any(String),
          mcpAnnotations: expect.any(Object),
        }),
      );
    });
  });

  describe("GET /api/ai/governance/usage", () => {
    it("[AIG-01] needs ai.governance.manage; rejects a bad month", async () => {
      expect((await asker.get("/api/ai/governance/usage")).status).toBe(403);
      expect(
        (await admin.get("/api/ai/governance/usage?month=2026-13")).status,
      ).toBe(422);
      expect(
        (await admin.get("/api/ai/governance/usage?month=2026-03&x=1")).status,
      ).toBe(422);
    });

    it("sums one month of this tenant only", async () => {
      const res = await admin.get("/api/ai/governance/usage?month=2026-03");
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.month).toBe("2026-03");
      expect(data.budget).toMatchObject({
        monthlyBudgetIdr: 500_000,
        usedIdr: 100,
        state: "ok",
      });
      expect(data.byFeature).toEqual([
        {
          feature: "AI-01",
          jobs: 2,
          blockedJobs: 1,
          tokensIn: 300,
          tokensOut: 300,
          costIdr: 100,
        },
        {
          feature: "AI-02",
          jobs: 0,
          blockedJobs: 1,
          tokensIn: 0,
          tokensOut: 0,
          costIdr: 0,
        },
      ]);
      const reasons = Object.fromEntries(
        data.blockedByReason.map((r: { reason: string; count: number }) => [
          r.reason,
          r.count,
        ]),
      );
      expect(reasons).toEqual({
        quota_exceeded: 1,
        pii_blocked: 1,
        permission_denied: 1,
        tool_disabled: 1,
      });
      expect(data.mcpToolCalls).toBe(1);
    });

    it("defaults to the current month and never counts tenant B", async () => {
      const res = await admin.get("/api/ai/governance/usage");
      expect(res.status).toBe(200);
      expect(res.body.data.month).toBe(thisMonth());
      expect(res.body.data.mcpToolCalls).toBe(1);
      expect(res.body.data.byFeature).toEqual([]);
    });
  });

  describe("GET /api/ai/tool-calls", () => {
    const list = (query = "") => admin.get(`/api/ai/tool-calls${query}`);

    it("[AIG-01] needs ai.governance.manage", async () => {
      expect((await asker.get("/api/ai/tool-calls")).status).toBe(403);
      expect((await agent(app).get("/api/ai/tool-calls")).status).toBe(401);
    });

    it("[TEN-01] lists this tenant's calls newest first and never tenant B's", async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(
        res.body.data.map((r: { toolCode: string }) => r.toolCode),
      ).toEqual(["TL-06", "TL-05", "TL-04", "TL-03", "TL-02", "TL-01"]);
      expect(
        res.body.data.every(
          (r: { tenantId: string }) => r.tenantId === tenant.id,
        ),
      ).toBe(true);
      expect(res.body.meta).toEqual({ limit: 25, nextCursor: null });
      const first = (await list("?toolCode=TL-07")).body.data;
      expect(first).toEqual([]);
    });

    it("returns redacted scalar params only and maps the outcomes", async () => {
      const rows = (await list()).body.data as {
        toolCode: string;
        outcome: string;
        redactedParams: Record<string, unknown>;
        rowCount: number;
        durationMs: number;
      }[];
      const by = Object.fromEntries(rows.map((r) => [r.toolCode, r]));
      expect(by["TL-01"]!.redactedParams).toEqual({
        period: "today",
        nested: '{"a":1}',
      });
      expect(by["TL-01"]).toMatchObject({
        outcome: "ok",
        rowCount: 3,
        durationMs: 12,
      });
      expect(by["TL-02"]!.outcome).toBe("denied");
      expect(by["TL-03"]!.outcome).toBe("disabled");
      expect(by["TL-04"]!.outcome).toBe("rate_limited");
      expect(by["TL-05"]!.outcome).toBe("error");
    });

    it("filters by outcome, channel, tool and user", async () => {
      const codes = async (q: string) =>
        ((await list(q)).body.data as { toolCode: string }[]).map(
          (r) => r.toolCode,
        );
      expect(await codes("?outcome=denied")).toEqual(["TL-02"]);
      expect(await codes("?outcome=disabled")).toEqual(["TL-03"]);
      expect(await codes("?outcome=rate_limited")).toEqual(["TL-04"]);
      expect(await codes("?outcome=error")).toEqual(["TL-05"]);
      expect(await codes("?outcome=ok")).toEqual(["TL-06", "TL-01"]);
      expect(await codes("?channel=mcp")).toEqual(["TL-06", "TL-04"]);
      expect(await codes("?toolCode=TL-02")).toEqual(["TL-02"]);
      expect(await codes(`?userId=${adminId}`)).toHaveLength(6);
      expect(await codes(`?userId=${otherUser}`)).toEqual([]);
    });

    it("pages with an opaque cursor without gaps or repeats; rejects a tampered cursor", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i += 1) {
        const res = await list(
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(res.status).toBe(200);
        seen.push(
          ...res.body.data.map((r: { toolCode: string }) => r.toolCode),
        );
        cursor = res.body.meta.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([
        "TL-06",
        "TL-05",
        "TL-04",
        "TL-03",
        "TL-02",
        "TL-01",
      ]);
      expect((await list("?cursor=%25%25")).status).toBe(422);
      expect((await list("?limit=0")).status).toBe(422);
      expect((await list("?bogus=1")).status).toBe(422);
    });
  });
});
