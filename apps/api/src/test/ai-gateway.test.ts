// AI gateway against PostgreSQL with the restricted app role (RLS enforced):
// PRD v1.7 §40 AIG-01..05, AI-12; bead legend-zfi4. The gateway is called with
// stub `AccessSnapshot`s (the gateway never widens access; the tool handlers
// do the data checks), real users and the real tables.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AiError, type AiGovernanceSettings } from "@starter/shared/ai";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createFakeProvider } from "../lib/ai/fake.ts";
import { setAiProviderForTests } from "../lib/ai/provider-factory.ts";
import type { AiProvider } from "../lib/ai/types.ts";
import {
  aiCacheGet,
  aiCachePut,
  aiComplete,
  aiPreflight,
  getAiSettings,
  usageMonthOf,
} from "../services/ai-gateway.service.ts";
import { costMicroUsd, microUsdToIdr } from "../services/ai-pricing.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = randomUUID();
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'AI gateway', $2)`,
    [id, `${id}@example.test`],
  );
  return id;
}

function accessFor(
  tenantId: string,
  userId: string,
  templateKeys: string[] = ["employee"],
  permissions: string[] = ["ai.ask"],
  /** Outlets the caller reaches; omit for "everything" (tenant-wide). */
  reach?: readonly string[],
  mfa: { required: boolean; verified: boolean } = {
    required: false,
    verified: true,
  },
): AccessSnapshot {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  type Target = { type: string; id?: string };
  const allows = (_code: string, target: Target) =>
    reach === undefined ||
    (target.type === "outlet" && reach.includes(target.id ?? ""));
  return {
    tenant,
    userId,
    permissions,
    mfaRequired: mfa.required,
    mfaVerified: mfa.verified,
    templateKeys,
    allows,
    permissionsVia: () => permissions,
    allowsVia: (_key: string, code: string, target: Target) =>
      allows(code, target),
    contextFor: () => null,
    stationsFor: () => [],
  } as unknown as AccessSnapshot;
}

type SettingsPatch = {
  aiEnabled?: boolean;
  monthlyBudgetIdr?: number;
  budgetWarnPct?: number;
  budgetStopPct?: number;
  features?: AiGovernanceSettings["features"];
};

async function seedSettings(
  tenantId: string,
  userId: string,
  p: SettingsPatch,
) {
  await owner.query(`DELETE FROM ai_settings WHERE tenant_id = $1`, [tenantId]);
  await owner.query(
    `INSERT INTO ai_settings (tenant_id, updated_by, ai_enabled, monthly_budget_idr,
       budget_warn_pct, budget_stop_pct, features)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      tenantId,
      userId,
      p.aiEnabled ?? true,
      p.monthlyBudgetIdr ?? 1_000_000,
      p.budgetWarnPct ?? 80,
      p.budgetStopPct ?? 100,
      JSON.stringify(p.features ?? []),
    ],
  );
}

async function resetUsage(tenantId: string) {
  for (const table of ["ai_usage_events", "ai_usage_daily", "ai_usage_monthly"])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
}

const ask = (a: AccessSnapshot, text = "Berapa penjualan kemarin?") =>
  aiPreflight(a, { feature: "AI-01", channel: "app", text });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiError) return error.code;
    throw error;
  }
  return "OK";
};

let userA: string;
let userA2: string;
let userB: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'AI gateway tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantB, `ai-gw-${tenantB.slice(0, 8)}`, tenantA],
  );
  userA = await makeUser();
  userA2 = await makeUser();
  userB = await makeUser();
});

afterEach(async () => {
  vi.useRealTimers();
  setAiProviderForTests(undefined);
  await resetUsage(tenantA);
  await resetUsage(tenantB);
  await owner.query(`DELETE FROM ai_response_cache WHERE tenant_id = ANY($1)`, [
    [tenantA, tenantB],
  ]);
});

afterAll(async () => {
  for (const table of [
    "ai_response_cache",
    "ai_usage_monthly",
    "ai_usage_daily",
    "ai_usage_events",
    "ai_settings",
  ])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
      [tenantA, tenantB],
    ]);
  await owner
    .query(`DELETE FROM domain_event_outbox WHERE tenant_id = $1`, [tenantB])
    .catch(() => undefined);
  await owner
    .query(`DELETE FROM tenants WHERE id = $1`, [tenantB])
    .catch(() => undefined);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1)`, [createdUsers]);
  await owner.end();
});

describe("pricing", () => {
  it("prices per model; unknown model costs like opus", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costMicroUsd("claude-opus-5-5", usage)).toBe(24_000_000);
    expect(costMicroUsd("claude-sonnet-5-5", usage)).toBe(12_000_000);
    expect(costMicroUsd("claude-haiku-5-5", usage)).toBe(600_000);
    expect(costMicroUsd("some-new-model", usage)).toBe(24_000_000);
    expect(
      costMicroUsd("claude-opus-5-5", { inputTokens: 1, outputTokens: 0 }),
    ).toBe(4);
    expect(microUsdToIdr(1_000_000)).toBeGreaterThan(10_000);
  });
});

describe("aiPreflight", () => {
  it("[AIG-01] fails closed: no settings row means a zero budget", async () => {
    await owner.query(`DELETE FROM ai_settings WHERE tenant_id = $1`, [
      tenantA,
    ]);
    expect(
      (await getAiSettings(accessFor(tenantA, userA))).monthlyBudgetIdr,
    ).toBe(0);
    expect(await code(ask(accessFor(tenantA, userA)))).toBe(
      "AI_BUDGET_EXCEEDED",
    );
  });

  it("[AIG-01] tenant switch and feature switch block with AI_FEATURE_DISABLED", async () => {
    await seedSettings(tenantA, userA, { aiEnabled: false });
    expect(await code(ask(accessFor(tenantA, userA)))).toBe(
      "AI_FEATURE_DISABLED",
    );
    await seedSettings(tenantA, userA, {
      features: [{ feature: "AI-01", isEnabled: false, dailyLimitByRole: {} }],
    });
    expect(await code(ask(accessFor(tenantA, userA)))).toBe(
      "AI_FEATURE_DISABLED",
    );
    expect(
      await code(
        aiPreflight(accessFor(tenantA, userA), {
          feature: "AI-02",
          channel: "app",
          text: "halo",
        }),
      ),
    ).toBe("OK");
  });

  it("[AIG-02] PII is blocked; own payslip data passes with allowOwnData; login codes never", async () => {
    await seedSettings(tenantA, userA, {});
    const a = accessFor(tenantA, userA);
    const text = "Gaji saya Rp 8.500.000, kenapa dipotong?";
    expect(await code(ask(a, text))).toBe("AI_PII_BLOCKED");
    expect(
      await code(
        aiPreflight(a, {
          feature: "AI-01",
          channel: "app",
          text,
          allowOwnData: true,
        }),
      ),
    ).toBe("OK");
    expect(
      await code(
        aiPreflight(a, {
          feature: "AI-01",
          channel: "app",
          text: "hubungi 081234567890",
          allowOwnData: true,
        }),
      ),
    ).toBe("AI_PII_BLOCKED");
    const blocked = await owner.query(
      `SELECT count(*)::int AS n FROM ai_usage_events WHERE tenant_id = $1 AND status = 'blocked' AND error_code = 'AI_PII_BLOCKED'`,
      [tenantA],
    );
    expect(blocked.rows[0].n).toBe(2);
  });

  it.each([
    ["01:18 WIB", "2026-11-12T01:18:00+07:00", "2026-11-11"],
    ["12:00 WIB", "2026-11-12T12:00:00+07:00", "2026-11-12"],
  ])(
    "[AIG-01] daily quota at %s: 30 employee / 100 management defaults, override by role; blocked calls do not count",
    async (_clock, now, expectedUsageDate) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      const usageDate = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
      expect(usageDate).toBe(expectedUsageDate);
      await seedSettings(tenantA, userA, {
        features: [
          {
            feature: "AI-01",
            isEnabled: true,
            dailyLimitByRole: { employee: 2 },
          },
        ],
      });
      const employee = accessFor(tenantA, userA, ["employee"]);
      expect(await code(ask(employee))).toBe("OK");
      expect(await code(ask(employee))).toBe("OK");
      expect(await code(ask(employee))).toBe("AI_QUOTA_EXCEEDED");
      expect(await code(ask(employee))).toBe("AI_QUOTA_EXCEEDED");
      const count = await owner.query(
        `SELECT usage_date::text, request_count FROM ai_usage_daily WHERE tenant_id = $1 AND user_id = $2`,
        [tenantA, userA],
      );
      expect(count.rows).toEqual([
        { usage_date: expectedUsageDate, request_count: 2 },
      ]);
      // A caller holding a management role gets the higher limit.
      const both = accessFor(tenantA, userA2, ["employee", "general_manager"]);
      for (let i = 0; i < 3; i += 1) expect(await code(ask(both))).toBe("OK");
      // Defaults without override: employee 30.
      await seedSettings(tenantA, userA, {});
      await owner.query(
        `INSERT INTO ai_usage_daily (tenant_id, user_id, usage_date, request_count)
       VALUES ($1, $2, $3::date, 29)
       ON CONFLICT (tenant_id, user_id, usage_date) DO UPDATE SET request_count = 29`,
        [tenantA, userA, usageDate],
      );
      expect(await code(ask(employee))).toBe("OK");
      expect(await code(ask(employee))).toBe("AI_QUOTA_EXCEEDED");
      const exhausted = await owner.query(
        `SELECT usage_date::text, request_count FROM ai_usage_daily WHERE tenant_id = $1 AND user_id = $2`,
        [tenantA, userA],
      );
      expect(exhausted.rows).toEqual([
        { usage_date: expectedUsageDate, request_count: 30 },
      ]);
    },
  );

  it("[AIG-01] two parallel calls at limit-1 let exactly one through", async () => {
    await seedSettings(tenantA, userA, {
      features: [
        {
          feature: "AI-01",
          isEnabled: true,
          dailyLimitByRole: { employee: 5 },
        },
      ],
    });
    const a = accessFor(tenantA, userA, ["employee"]);
    for (let i = 0; i < 4; i += 1) await ask(a);
    const results = await Promise.all([code(ask(a)), code(ask(a))]);
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "AI_QUOTA_EXCEEDED")).toHaveLength(1);
  });

  it("[AIG-04] a month at the stop threshold blocks with AI_BUDGET_EXCEEDED", async () => {
    await seedSettings(tenantA, userA, { monthlyBudgetIdr: 1000 });
    await owner.query(
      `INSERT INTO ai_usage_monthly (tenant_id, usage_month, cost_idr, cost_micro_usd)
       VALUES ($1, $2, 1000, 61000)`,
      [tenantA, usageMonthOf(new Date())],
    );
    expect(await code(ask(accessFor(tenantA, userA)))).toBe(
      "AI_BUDGET_EXCEEDED",
    );
  });
});

describe("aiComplete", () => {
  const req = {
    system: "Kamu asisten.",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "halo" }],
      },
    ],
    tools: [],
    maxTokens: 100,
  };
  const meta = { feature: "AI-01", channel: "app" as const };

  it("records usage and cost; the month total is derived from micro-USD", async () => {
    await seedSettings(tenantA, userA, {});
    setAiProviderForTests(
      createFakeProvider(() => ({
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1000, outputTokens: 500 },
        model: "claude-opus-5-5",
      })),
    );
    await aiComplete(accessFor(tenantA, userA), req, meta);
    await aiComplete(accessFor(tenantA, userA), req, meta);
    const events = await owner.query(
      `SELECT status, cost_micro_usd::int AS micro, channel, input_tokens FROM ai_usage_events WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({
      status: "ok",
      micro: 14_000,
      channel: "tanya_ai",
      input_tokens: 1000,
    });
    const monthly = await owner.query(
      `SELECT cost_micro_usd::int AS micro, cost_idr::int AS idr, request_count FROM ai_usage_monthly WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(monthly.rows[0]).toMatchObject({
      micro: 28_000,
      idr: microUsdToIdr(28_000),
      request_count: 2,
    });
  });

  it("[AIG-05] no provider, a failure and a timeout all become AI_PROVIDER_UNAVAILABLE without detail", async () => {
    await seedSettings(tenantA, userA, {});
    const a = accessFor(tenantA, userA);
    setAiProviderForTests(null);
    expect(await code(aiComplete(a, req, meta))).toBe(
      "AI_PROVIDER_UNAVAILABLE",
    );
    const failing: AiProvider = {
      name: "fake",
      async complete() {
        throw new Error("secret upstream detail sk-123");
      },
    };
    setAiProviderForTests(failing);
    const error = await aiComplete(a, req, meta).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect((error as AiError).message).not.toContain("sk-123");
    const failed = await owner.query(
      `SELECT count(*)::int AS n FROM ai_usage_events WHERE tenant_id = $1 AND status = 'error'`,
      [tenantA],
    );
    expect(failed.rows[0].n).toBe(2);
    const monthly = await owner.query<{
      cost_idr: string;
      reserved_cost_idr: string;
      request_count: number;
    }>(
      `SELECT cost_idr, reserved_cost_idr, request_count FROM ai_usage_monthly WHERE tenant_id = $1`,
      [tenantA],
    );
    // A transport failure may already have been billed. Keep its reservation
    // without inventing a successful request or a zero-cost completed call.
    expect(monthly.rows).toHaveLength(1);
    expect(Number(monthly.rows[0]!.cost_idr)).toBe(0);
    expect(Number(monthly.rows[0]!.reserved_cost_idr)).toBeGreaterThan(0);
    expect(monthly.rows[0]!.request_count).toBe(0);
  });

  it("[AIG-02] the warn event fires once per month, the stop event once, and the stop blocks", async () => {
    // Own tenant so the outbox rows are easy to count.
    await seedSettings(tenantB, userB, { monthlyBudgetIdr: 1000 });
    const b = accessFor(tenantB, userB, ["owner"]);
    const answered = vi.fn(() => ({
      content: [{ type: "text" as const, text: "ok" }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 100, outputTokens: 50 },
      model: "claude-opus-5-5",
    }));
    setAiProviderForTests(createFakeProvider(answered));
    const month = usageMonthOf(new Date());
    const seed = (micro: number) =>
      owner.query(
        `INSERT INTO ai_usage_monthly (tenant_id, usage_month, cost_idr, cost_micro_usd)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, usage_month) DO UPDATE SET cost_micro_usd = $4, cost_idr = $3`,
        [tenantB, month, microUsdToIdr(micro), micro],
      );
    const thresholds = async () =>
      (
        await owner.query(
          `SELECT event -> 'payload' ->> 'threshold' AS t FROM domain_event_outbox
            WHERE tenant_id = $1 AND aggregate_type = 'ai_budget' ORDER BY sequence`,
          [tenantB],
        )
      ).rows.map((r) => r.t as string);

    await seed(10_000); // ~Rp 165 of 1000: below warn
    await aiComplete(b, req, meta);
    expect(await thresholds()).toEqual([]);
    await seed(50_000); // ~Rp 825: above 80%
    await aiComplete(b, req, meta);
    await aiComplete(b, req, meta);
    expect(await thresholds()).toEqual(["warn"]);
    await seed(61_000); // Previously incurred usage is now above 100%.
    expect(await code(aiComplete(b, req, meta))).toBe("AI_BUDGET_EXCEEDED");
    expect(await code(aiComplete(b, req, meta))).toBe("AI_BUDGET_EXCEEDED");
    expect(answered).toHaveBeenCalledTimes(3);
    expect(await thresholds()).toEqual(["warn", "stop"]);
    expect(await code(ask(b))).toBe("AI_BUDGET_EXCEEDED");
  });
});

describe("response cache (AI-12)", () => {
  const key = { scope: "last_7_days", question: "Penjualan minggu ini?" };

  it("returns what was stored for the same rights; clamps the TTL to 7 days", async () => {
    const a = accessFor(
      tenantA,
      userA,
      ["general_manager"],
      ["ai.ask", "report.sales.view"],
    );
    expect(await aiCacheGet(a, key)).toBeNull();
    await aiCachePut(a, key, { answer: "Rp 1" }, 30 * 24 * 3600);
    expect(
      await aiCacheGet(a, { ...key, question: "  penjualan   MINGGU ini? " }),
    ).toEqual({ answer: "Rp 1" });
    const row = await owner.query(
      `SELECT (expires_at - created_at) <= interval '7 days' AS ok FROM ai_response_cache WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(row.rows[0].ok).toBe(true);
    await owner.query(
      `UPDATE ai_response_cache SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(await aiCacheGet(a, key)).toBeNull();
  });

  it("different permission set, outlet scope or scope string never shares an entry", async () => {
    const a = accessFor(
      tenantA,
      userA,
      ["general_manager"],
      ["ai.ask", "report.sales.view"],
    );
    const narrower = accessFor(
      tenantA,
      userA2,
      ["general_manager"],
      ["ai.ask"],
    );
    await aiCachePut(a, key, { answer: "Rp 1" }, 3600);
    expect(await aiCacheGet(narrower, key)).toBeNull();
    expect(
      await aiCacheGet(a, { ...key, outletIds: [randomUUID()] }),
    ).toBeNull();
    expect(await aiCacheGet(a, { ...key, scope: "today" })).toBeNull();
    // Same permission set, another user: never shared (the codes do not say
    // which outlets each user reaches).
    const twin = accessFor(
      tenantA,
      userA2,
      ["general_manager"],
      ["report.sales.view", "ai.ask"],
    );
    expect(await aiCacheGet(twin, key)).toBeNull();
    expect(await aiCacheGet(a, key)).toEqual({ answer: "Rp 1" });
  });
});

describe("response cache: outlet managers and kill switch", () => {
  const key = { scope: "last_7_days", question: "Penjualan minggu ini?" };

  it("[TEN-03] two outlet managers with the same codes and question share nothing, even if one passes the other's outlet id", async () => {
    const [outletA, outletB] = cafeLegendPlatformFixtures.outlets.map(
      (o) => o.id,
    );
    const perms = ["ai.ask", "report.sales.view"];
    const managerA = accessFor(tenantA, userA, ["outlet_manager"], perms, [
      outletA!,
    ]);
    const managerB = accessFor(tenantA, userA2, ["outlet_manager"], perms, [
      outletB!,
    ]);
    await aiCachePut(
      managerA,
      { ...key, outletIds: [outletA!] },
      { answer: "outlet A" },
      3600,
    );
    expect(
      await aiCacheGet(managerB, { ...key, outletIds: [outletB!] }),
    ).toBeNull();
    expect(
      await aiCacheGet(managerB, { ...key, outletIds: [outletA!] }),
    ).toBeNull();
    expect(await aiCacheGet(managerB, key)).toBeNull();
    await aiCachePut(
      managerB,
      { ...key, outletIds: [outletB!] },
      { answer: "outlet B" },
      3600,
    );
    expect(
      await aiCacheGet(managerA, { ...key, outletIds: [outletA!] }),
    ).toEqual({ answer: "outlet A" });
    expect(
      await aiCacheGet(managerB, { ...key, outletIds: [outletB!] }),
    ).toEqual({ answer: "outlet B" });
  });

  it("[TEN-03] the same user removed from an outlet (or given another) gets no old answer", async () => {
    const [outletA, outletB] = cafeLegendPlatformFixtures.outlets.map(
      (o) => o.id,
    );
    const perms = ["ai.ask", "report.sales.view"];
    const before = accessFor(tenantA, userA, ["outlet_manager"], perms, [
      outletA!,
      outletB!,
    ]);
    await aiCachePut(before, key, { answer: "dua outlet" }, 3600);
    expect(await aiCacheGet(before, key)).toEqual({ answer: "dua outlet" });
    const afterRemoval = accessFor(tenantA, userA, ["outlet_manager"], perms, [
      outletA!,
    ]);
    expect(await aiCacheGet(afterRemoval, key)).toBeNull();
    const moved = accessFor(tenantA, userA, ["outlet_manager"], perms, [
      outletB!,
    ]);
    expect(await aiCacheGet(moved, key)).toBeNull();
  });

  it("[AIG-01] a different MFA state never shares an entry", async () => {
    const same = (verified: boolean) =>
      accessFor(tenantA, userA, ["general_manager"], ["ai.ask"], undefined, {
        required: true,
        verified,
      });
    await aiCachePut(same(true), key, { answer: "mfa" }, 3600);
    expect(await aiCacheGet(same(true), key)).toEqual({ answer: "mfa" });
    expect(await aiCacheGet(same(false), key)).toBeNull();
    const notRequired = accessFor(
      tenantA,
      userA,
      ["general_manager"],
      ["ai.ask"],
      undefined,
      {
        required: false,
        verified: true,
      },
    );
    expect(await aiCacheGet(notRequired, key)).toBeNull();
  });

  it("[TEN-03] swapping the role at an outlet changes the reach even with the same permission union", async () => {
    const [outletA, outletB] = cafeLegendPlatformFixtures.outlets.map(
      (o) => o.id,
    );
    // Same user, same union of codes, same outlets in the union; only WHICH
    // role holds which code at which outlet differs.
    const roles = (via: Record<string, Record<string, string[]>>) => {
      const base = accessFor(tenantA, userA, Object.keys(via), [
        "ai.ask",
        "report.sales.view",
      ]);
      return {
        ...base,
        allows: (code: string, target: { type: string; id?: string }) =>
          Object.entries(via).some(([, perms]) =>
            (perms[code] ?? []).includes(
              target.type === "outlet" ? target.id! : "tenant",
            ),
          ),
        permissionsVia: (key: string) => Object.keys(via[key] ?? {}),
        allowsVia: (
          key: string,
          code: string,
          target: { type: string; id?: string },
        ) =>
          ((via[key] ?? {})[code] ?? []).includes(
            target.type === "outlet" ? target.id! : "tenant",
          ),
      } as unknown as AccessSnapshot;
    };
    const before = roles({
      outlet_manager: { "report.sales.view": [outletA!] },
      cashier: { "ai.ask": [outletB!] },
    });
    const swapped = roles({
      outlet_manager: { "ai.ask": [outletB!] },
      cashier: { "report.sales.view": [outletA!] },
    });
    await aiCachePut(before, key, { answer: "peran lama" }, 3600);
    expect(await aiCacheGet(before, key)).toEqual({ answer: "peran lama" });
    expect(await aiCacheGet(swapped, key)).toBeNull();
  });

  it("a settings change (kill switch) invalidates earlier cached answers", async () => {
    await seedSettings(tenantA, userA, {});
    const a = accessFor(tenantA, userA, ["general_manager"], ["ai.ask"]);
    await aiCachePut(a, key, { answer: "lama" }, 3600);
    expect(await aiCacheGet(a, key)).toEqual({ answer: "lama" });
    await owner.query(
      `UPDATE ai_settings SET disabled_tool_codes = ARRAY['TL-01'], updated_at = now() + interval '1 second' WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(await aiCacheGet(a, key)).toBeNull();
  });
});

describe("[TEN-01] tenant isolation", () => {
  it("settings, usage and cache of tenant A are invisible to tenant B", async () => {
    await seedSettings(tenantA, userA, { monthlyBudgetIdr: 123_456 });
    expect(
      (await getAiSettings(accessFor(tenantB, userB))).monthlyBudgetIdr,
    ).not.toBe(123_456);
    const a = accessFor(tenantA, userA, ["owner"], ["ai.ask"]);
    const b = accessFor(tenantB, userB, ["owner"], ["ai.ask"]);
    await aiCachePut(a, { scope: "s", question: "q" }, { v: 1 }, 60);
    expect(await aiCacheGet(b, { scope: "s", question: "q" })).toBeNull();
    await ask(a);
    const daily = await owner.query(
      `SELECT count(*)::int AS n FROM ai_usage_daily WHERE tenant_id = $1`,
      [tenantB],
    );
    expect(daily.rows[0].n).toBe(0);
  });
});
