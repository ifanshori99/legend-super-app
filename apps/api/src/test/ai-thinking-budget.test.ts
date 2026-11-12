// legend-39d.8: adaptive reasoning and every paid turn obey the tenant cap.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AiError } from "@starter/shared/ai";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { env } from "../config/env.ts";
import { setAiProviderForTests } from "../lib/ai/provider-factory.ts";
import type {
  AiChatMessage,
  AiCompletionRequest,
  AiCompletionResult,
} from "../lib/ai/types.ts";
import { aiComplete, usageMonthOf } from "../services/ai-gateway.service.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";

const capabilities = {
  contextWindow: 16_384,
  maxOutputTokens: 2048,
  supportsTools: true,
  supportsReasoning: true,
  reasoningEfforts: ["low", "medium", "high"] as ("low" | "medium" | "high")[],
  source: "known" as const,
};
const message = (text: string): AiChatMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const request: AiCompletionRequest = {
  system: "Kamu asisten.",
  messages: [message("Halo")],
  tools: [],
  maxTokens: 1000,
};

// Dynamic imports let the DB regression cases run against the existing gateway
// while the new pure policy is introduced independently.
describe("thinking and context policy", () => {
  it("uses low effort for a short question and high for forecast or multiple tool rounds", async () => {
    const { selectReasoningEffort } =
      await import("../lib/ai/request-policy.ts");
    expect(selectReasoningEffort({ question: "Halo", capabilities })).toBe(
      "low",
    );
    expect(
      selectReasoningEffort({
        question: "Analisis penjualan dan forecast tiga bulan berikutnya",
        capabilities,
      }),
    ).toBe("high");
    expect(
      selectReasoningEffort({
        question: "Penjualan?",
        capabilities,
        toolRounds: 3,
      }),
    ).toBe("high");
  });

  it("omits reasoning on unsupported models and respects their advertised effort set", async () => {
    const { selectReasoningEffort, prepareAiRequest } =
      await import("../lib/ai/request-policy.ts");
    const noReasoning = {
      ...capabilities,
      supportsReasoning: false,
      reasoningEfforts: [],
    };
    expect(
      selectReasoningEffort({
        question: "Analisis forecast",
        capabilities: noReasoning,
      }),
    ).toBeUndefined();
    const prepared = prepareAiRequest(
      { ...request, reasoningEffort: "high" },
      noReasoning,
    );
    expect(prepared).not.toHaveProperty("reasoningEffort");
    expect(
      selectReasoningEffort({
        question: "Analisis forecast",
        capabilities: { ...capabilities, reasoningEfforts: ["low"] },
      }),
    ).toBe("low");
  });

  it("caps total generated tokens including thinking to the detected maximum", async () => {
    const { prepareAiRequest } = await import("../lib/ai/request-policy.ts");
    expect(
      prepareAiRequest({ ...request, maxTokens: 8000 }, capabilities).maxTokens,
    ).toBe(2048);
  });

  it("trims old conversations to the context allowance while keeping tool use/result together", async () => {
    const { trimMessagesToContext, estimateRequestInputTokens } =
      await import("../lib/ai/request-policy.ts");
    const toolPair: AiChatMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "sales", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "call-1", content: "100" }],
      },
    ];
    const latest = message("Berapa totalnya?");
    const messages = trimMessagesToContext(
      [message("lama".repeat(2000)), ...toolPair, latest],
      4096,
      1024,
      request.system,
    );
    expect(messages).toContainEqual(latest);
    expect(messages).not.toContainEqual(message("lama".repeat(2000)));
    const toolUses = messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id);
    const results = messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => b.toolUseId);
    expect(results).toEqual(toolUses);
    expect(
      estimateRequestInputTokens({ ...request, messages }) + 1024,
    ).toBeLessThanOrEqual(4096);
  });

  it("counts system and tool schemas in the input allowance", async () => {
    const { prepareAiRequest } = await import("../lib/ai/request-policy.ts");
    expect(() =>
      prepareAiRequest(
        {
          ...request,
          tools: [
            { name: "large", description: "x".repeat(10_000), inputSchema: {} },
          ],
        },
        { ...capabilities, contextWindow: 4096 },
      ),
    ).toThrow();
  });
});

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const tenantId = randomUUID();
const userId = randomUUID();
const access = {
  tenant: establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  }),
  userId,
  permissions: ["ai.ask"],
  templateKeys: ["owner"],
  mfaRequired: false,
  mfaVerified: true,
  allows: () => true,
  permissionsVia: () => ["ai.ask"],
  allowsVia: () => true,
  contextFor: () => null,
  stationsFor: () => [],
} as unknown as AccessSnapshot;
const meta = { feature: "AI-01", channel: "app" as const };
const answer = (): AiCompletionResult => ({
  content: [{ type: "text", text: "OK" }],
  stopReason: "end_turn",
  usage: { inputTokens: 100, outputTokens: 100 },
  model: env.AI_MODEL,
});
async function budget(value: number) {
  await owner.query(
    "UPDATE ai_settings SET monthly_budget_idr = $2 WHERE tenant_id = $1",
    [tenantId, value],
  );
}
const errorCode = async (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (e: unknown) => (e instanceof AiError ? e.code : Promise.reject(e)),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO "user" (id,name,email) VALUES ($1,'AI budget test',$2)`,
    [userId, `${userId}@example.test`],
  );
  await owner.query(
    `INSERT INTO tenants (id,slug,name,plan,status,deployment_mode,feature_flags,limits,created_by)
    SELECT $1,$2,'AI budget isolated',plan,status,deployment_mode,feature_flags,limits,created_by FROM tenants WHERE id=$3`,
    [
      tenantId,
      `ai-budget-${tenantId.slice(0, 8)}`,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO ai_settings (tenant_id,updated_by,monthly_budget_idr) VALUES ($1,$2,0)`,
    [tenantId, userId],
  );
});
beforeEach(async () => {
  await budget(0);
  for (const table of ["ai_usage_events", "ai_usage_daily", "ai_usage_monthly"])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
});
afterEach(() => {
  setAiProviderForTests(undefined);
  vi.restoreAllMocks();
});
afterAll(async () => {
  for (const table of [
    "ai_usage_events",
    "ai_usage_daily",
    "ai_usage_monthly",
    "ai_settings",
  ])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  await owner.query("DELETE FROM domain_event_outbox WHERE tenant_id=$1", [
    tenantId,
  ]);
  await owner.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await owner.query(`DELETE FROM "user" WHERE id=$1`, [userId]);
  await owner.end();
});

describe("per-call budget reservation", () => {
  it("keeps the default zero budget closed even when aiComplete is called directly", async () => {
    const complete = vi.fn(async () => answer());
    setAiProviderForTests({ name: "fixture", complete });
    expect(await errorCode(aiComplete(access, request, meta))).toBe(
      "AI_BUDGET_EXCEEDED",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a costly thinking turn when the positive remaining budget cannot cover it", async () => {
    await budget(1);
    const complete = vi.fn(async () => answer());
    setAiProviderForTests({ name: "fixture", complete });
    expect(
      await errorCode(
        aiComplete(access, { ...request, reasoningEffort: "high" }, meta),
      ),
    ).toBe("AI_BUDGET_EXCEEDED");
    expect(complete).not.toHaveBeenCalled();
  });

  it("reserves concurrent calls atomically so only the affordable call reaches the provider", async () => {
    await budget(400);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const complete = vi.fn(async () => {
      await pending;
      return answer();
    });
    setAiProviderForTests({ name: "fixture", complete });
    const settled: string[] = [];
    const invoke = () =>
      errorCode(aiComplete(access, request, meta)).then((code) => {
        settled.push(code);
        return code;
      });
    const calls = [invoke(), invoke()];
    try {
      await vi.waitFor(() => {
        expect(settled).toEqual(["AI_BUDGET_EXCEEDED"]);
        expect(complete).toHaveBeenCalledTimes(1);
      });
    } finally {
      finish();
    }
    expect((await Promise.all(calls)).sort()).toEqual([
      "AI_BUDGET_EXCEEDED",
      "OK",
    ]);
    const used = await owner.query<{
      cost_idr: string;
      reserved_cost_idr: string;
    }>(
      "SELECT cost_idr,reserved_cost_idr FROM ai_usage_monthly WHERE tenant_id=$1 AND usage_month=$2",
      [tenantId, usageMonthOf(new Date())],
    );
    expect(Number(used.rows[0]!.cost_idr)).toBeLessThanOrEqual(400);
    expect(Number(used.rows[0]!.reserved_cost_idr)).toBe(0);
  });

  it("keeps an ambiguous failed call reserved rather than allowing another potentially paid turn", async () => {
    await budget(400);
    const complete = vi.fn(async () => {
      throw new Error("provider timed out after possibly charging");
    });
    setAiProviderForTests({ name: "fixture", complete });
    expect(await errorCode(aiComplete(access, request, meta))).toBe(
      "AI_PROVIDER_UNAVAILABLE",
    );
    expect(await errorCode(aiComplete(access, request, meta))).toBe(
      "AI_BUDGET_EXCEEDED",
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
