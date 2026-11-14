// Mock handlers for the AI & MCP usage page (VITE_API_MOCK=true): tenant usage
// of a month, tenant token list with revoke, and the tool-call audit. Fixtures
// come from @starter/shared/ai; the tenant usage has no shared fixture, so it
// is built here and parsed with the contract schema. The runtime validates every
// response with the same schema the API will use.
//
// Scenario URLs (relative to today, so they do not rot):
//   ?month=<this month>        budget warning at 82% (default)
//   ?month=<last month>        budget ok, 41%
//   ?month=<2 months ago>      budget stopped, over the cap
//   ?month=<3+ months ago>     empty month
//   ?mock=empty | slow | error | offline   empty lists, slow load, failure
// Tokens: active (two), revoked and expired rows are always present.
import {
  aiTenantUsageSchema,
  cafeLegendAiFixtures as fixtures,
  getAiTenantUsage,
  listAiToolCalls,
  listMcpTokens,
  mcpTokenIdSchema,
  mcpTokenSummarySchema,
  revokeMcpToken,
  type AiBlockedReason,
  type AiFeatureCode,
  type AiTenantUsage,
  type McpTokenSummary,
} from "@starter/shared/ai";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { idr, userIdSchema } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { settingsBudgetScenario } from "./settings-budget-scenario.ts";
import { monthOf } from "./usage-format.ts";

const CAP_IDR = 5_000_000;
const WARN_PCT = 80;
const STOP_PCT = 100;

type FeatureSeed = {
  feature: AiFeatureCode;
  jobs: number;
  blockedJobs: number;
  tokensIn: number;
  tokensOut: number;
  costIdr: number;
};

// One month at 82% of the cap; other months scale it.
const BASE_FEATURES: FeatureSeed[] = [
  {
    feature: "AI-02",
    jobs: 640,
    blockedJobs: 18,
    tokensIn: 1_420_000,
    tokensOut: 210_000,
    costIdr: 1_650_000,
  },
  {
    feature: "AI-05",
    jobs: 512,
    blockedJobs: 22,
    tokensIn: 1_050_000,
    tokensOut: 168_000,
    costIdr: 1_240_000,
  },
  {
    feature: "AI-04",
    jobs: 388,
    blockedJobs: 31,
    tokensIn: 640_000,
    tokensOut: 96_000,
    costIdr: 640_000,
  },
  {
    feature: "AI-10",
    jobs: 30,
    blockedJobs: 0,
    tokensIn: 260_000,
    tokensOut: 54_000,
    costIdr: 360_000,
  },
  {
    feature: "AI-09",
    jobs: 30,
    blockedJobs: 0,
    tokensIn: 120_000,
    tokensOut: 18_000,
    costIdr: 210_000,
  },
];

const BASE_BLOCKED: { reason: AiBlockedReason; count: number }[] = [
  { reason: "quota_exceeded", count: 38 },
  { reason: "permission_denied", count: 14 },
  { reason: "pii_blocked", count: 9 },
  { reason: "tool_disabled", count: 6 },
  { reason: "feature_disabled", count: 4 },
];

/** How many months before the current one (0 = this month). */
function monthsAgo(month: string, now: Date): number {
  const current = monthOf(now);
  const index = (value: string) =>
    Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
  return index(current) - index(month);
}

function budgetFor(
  usedIdr: number,
  capIdr: number = CAP_IDR,
): AiTenantUsage["budget"] {
  const pct = capIdr > 0 ? Math.floor((usedIdr * 100) / capIdr) : 0;
  return {
    monthlyBudgetIdr: idr(capIdr),
    usedIdr: idr(usedIdr),
    warnPct: WARN_PCT,
    stopPct: STOP_PCT,
    state: pct >= STOP_PCT ? "stopped" : pct >= WARN_PCT ? "warn" : "ok",
  };
}

function emptyUsage(month: string): AiTenantUsage {
  return aiTenantUsageSchema.parse({
    month,
    budget: budgetFor(0),
    byFeature: [],
    blockedByReason: [],
    mcpToolCalls: 0,
  });
}

function usageFor(month: string): AiTenantUsage {
  const ago = monthsAgo(month, new Date());
  if (ago < 0 || ago > 2) return emptyUsage(month);
  const factor = ago === 0 ? 1 : ago === 1 ? 0.5 : 1.25;
  const byFeature = BASE_FEATURES.map((seed) => ({
    ...seed,
    jobs: Math.round(seed.jobs * factor),
    blockedJobs: Math.round(seed.blockedJobs * factor),
    tokensIn: Math.round(seed.tokensIn * factor),
    tokensOut: Math.round(seed.tokensOut * factor),
    costIdr: Math.round(seed.costIdr * factor),
  }));
  const blockedByReason = BASE_BLOCKED.map((entry) => ({
    reason: entry.reason,
    count: Math.round(entry.count * factor),
  }));
  // A stopped month also blocked requests because of the cap itself.
  if (ago === 2)
    blockedByReason.unshift({ reason: "budget_exceeded", count: 57 });
  const used = byFeature.reduce((sum, row) => sum + row.costIdr, 0);
  return aiTenantUsageSchema.parse({
    month,
    budget: budgetFor(used),
    byFeature,
    blockedByReason,
    mcpToolCalls: Math.round(238 * factor),
  });
}

registerMock(getAiTenantUsage, ({ query, scenario }) => {
  const month = query.month ?? monthOf(new Date());
  // "Pengaturan AI" mockup states: this month's budget follows `?state=`.
  const settings = query.month === undefined ? settingsBudgetScenario() : null;
  if (settings)
    return {
      data: {
        ...emptyUsage(month),
        budget: budgetFor(settings.usedIdr, settings.capIdr),
      },
    };
  return {
    data: scenario === "empty" ? emptyUsage(month) : usageFor(month),
  };
});

// ---- Tokens ----------------------------------------------------------------

const clientName = new Map(
  fixtures.mcpClients.map((client) => [client.id, client.name]),
);
const userName = new Map(
  Object.values(cafeLegendAccessFixtures.users).map((user) => [
    user.id,
    user.displayName,
  ]),
);

const HOUR = 3_600_000;

function seedTokens(): McpTokenSummary[] {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const summaries = fixtures.mcpTokens.map((token, index) => {
    // The fixture clock is fixed in the past; keep the "active" token active
    // against the real clock so the list shows all three states.
    const expiresAt = index === 0 ? iso(4.5 * HOUR) : token.expiresAt;
    return {
      id: token.id,
      tenantId: token.tenantId,
      clientId: token.clientId,
      userId: token.userId,
      tokenPrefix: token.tokenPrefix,
      scopes: token.scopes,
      expiresAt,
      revokedAt: token.revokedAt,
      lastUsedAt: index === 0 ? iso(-5 * 60_000) : token.lastUsedAt,
      createdAt: token.createdAt,
      clientName: clientName.get(token.clientId),
      userDisplayName: userName.get(token.userId),
    };
  });
  const second = fixtures.mcpTokens[0]!;
  const financeUser = cafeLegendAccessFixtures.users.finance;
  summaries.push({
    id: mcpTokenIdSchema.parse("a1070000-0000-4000-8000-000000000099"),
    tenantId: second.tenantId,
    clientId: second.clientId,
    userId: userIdSchema.parse(financeUser.id),
    tokenPrefix: "mcp_k9L8m7N6",
    scopes: ["mcp:sales:read"],
    expiresAt: iso(2 * HOUR),
    revokedAt: null,
    lastUsedAt: iso(-3 * HOUR),
    createdAt: iso(-5 * HOUR),
    clientName: clientName.get(second.clientId),
    userDisplayName: financeUser.displayName,
  });
  return summaries.map((entry) => mcpTokenSummarySchema.parse(entry));
}

const tokens = createMockStore(seedTokens);

registerMock(listMcpTokens, ({ query, scenario }) => {
  if (query.scope !== "tenant")
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Daftar token tenant butuh izin admin.",
    );
  const rows = tokens
    .get()
    .filter(
      (token) =>
        query.clientId === undefined || token.clientId === query.clientId,
    )
    .filter(
      (token) =>
        query.includeInactive !== false ||
        (token.revokedAt === null && Date.parse(token.expiresAt) > Date.now()),
    );
  return paginateFixture(rows, query, (token) => token.id, scenario);
});

registerMock(revokeMcpToken, ({ params }) => {
  const list = tokens.get();
  const index = list.findIndex((token) => token.id === params.mcpTokenId);
  const current = list[index];
  if (!current) throw new ApiError(404, "NOT_FOUND", "Token tidak ditemukan.");
  const next = mcpTokenSummarySchema.parse({
    ...current,
    revokedAt: current.revokedAt ?? new Date().toISOString(),
  });
  tokens.set(list.map((token, i) => (i === index ? next : token)));
  return { data: next };
});

// ---- Tool-call audit ---------------------------------------------------------

registerMock(listAiToolCalls, ({ query, scenario }) => {
  const rows = [...fixtures.toolCallRecords]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .filter(
      (row) => query.channel === undefined || row.channel === query.channel,
    )
    .filter(
      (row) => query.outcome === undefined || row.outcome === query.outcome,
    )
    .filter(
      (row) => query.toolCode === undefined || row.toolCode === query.toolCode,
    )
    .filter(
      (row) =>
        query.mcpClientId === undefined ||
        row.mcpClientId === query.mcpClientId,
    )
    .filter((row) => query.userId === undefined || row.userId === query.userId);
  return paginateFixture(rows, query, (row) => row.id, scenario);
});
