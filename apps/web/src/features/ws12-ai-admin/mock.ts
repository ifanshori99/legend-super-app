// Mock handlers for the AI & MCP admin page (VITE_API_MOCK=true): governance
// settings with the master and kill switches, the tool list, and MCP clients
// (list, approve, revoke). Fixtures come from @starter/shared/ai; the tool list
// has no shared fixture, so it is built from the tool catalog here and parsed
// with the contract schema. Tenant usage, tokens and the tool-call audit are
// served by usage-mock.ts (the usage page owns those endpoints).
//
// Scenario URLs (page /kelola/pengaturan/mcp-ai):
//   ?mock=slow | error | offline   skeletons, error cards, offline message
//   ?mock=empty                    no MCP clients, no tools
//   ?ai=off                        master and Tanya AI switches start off
//   ?state=revoke                  opens the revoke dialog of the first client
// Defaults already cover: a pending client (approve flow), an active client
// with two users (revoke flow), a revoked client, and the budget at 82%
// (warning banner). Lower the cap with "Ubah" to see the stop banner.
import {
  AI_TOOL_CATALOG,
  aiGovernanceSettingsSchema,
  aiGovernanceToolSchema,
  approveMcpClient,
  cafeLegendAiFixtures as fixtures,
  getAiGovernanceSettings,
  isScopeSubset,
  listAiGovernanceTools,
  listMcpClients,
  mcpClientSchema,
  revokeMcpClient,
  updateAiGovernanceSettings,
  type AiGovernanceSettings,
  type McpClient,
} from "@starter/shared/ai";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { idr, userIdSchema } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { settingsBudgetScenario } from "./settings-budget-scenario.ts";

/** The tenant admin the mock records as the actor (mock mode only). */
const ACTOR = userIdSchema.parse(cafeLegendAccessFixtures.users.tenantAdmin.id);

/** Same cap as the usage mock, so the budget reads 82% of Rp 5.000.000. */
const CAP_IDR = 5_000_000;

function urlParam(name: string): string | null {
  const search = (globalThis as { location?: { search?: string } }).location
    ?.search;
  return search === undefined ? null : new URLSearchParams(search).get(name);
}

type MockState = {
  settings: AiGovernanceSettings;
  clients: McpClient[];
};

const seed = (): MockState => {
  const off = urlParam("ai") === "off";
  const scenario = settingsBudgetScenario();
  return {
    settings: aiGovernanceSettingsSchema.parse({
      ...fixtures.governanceSettings,
      monthlyBudgetIdr: idr(scenario?.capIdr ?? CAP_IDR),
      aiEnabled: !off,
      mcpEnabled: !off,
    }),
    clients: fixtures.mcpClients.map((client) =>
      mcpClientSchema.parse({ ...client }),
    ),
  };
};

const store = createMockStore(seed);

const now = () => new Date().toISOString();

// ---- Governance -----------------------------------------------------------

registerMock(getAiGovernanceSettings, () => ({
  data: store.get().settings,
}));

registerMock(updateAiGovernanceSettings, ({ body }) => {
  const state = store.get();
  const merged = { ...state.settings, ...body };
  // The schema only compares warn and stop when both are in the payload; the
  // API re-checks the merged row (schemas.ts checkGovernance).
  if (merged.budgetWarnPct >= merged.budgetStopPct)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Persentase peringatan harus lebih kecil dari persentase berhenti.",
      [
        {
          field: "budgetWarnPct",
          message:
            "Persentase peringatan harus lebih kecil dari persentase berhenti.",
        },
      ],
    );
  const settings = aiGovernanceSettingsSchema.parse({
    ...merged,
    updatedAt: now(),
    updatedBy: ACTOR,
  });
  store.set({ ...state, settings });
  return { data: settings };
});

registerMock(listAiGovernanceTools, ({ scenario }) => {
  if (scenario === "empty") return { data: [] };
  const disabled = new Set<string>(store.get().settings.disabledToolCodes);
  return {
    data: AI_TOOL_CATALOG.map((tool) =>
      aiGovernanceToolSchema.parse({
        code: tool.code,
        name: tool.name,
        kind: tool.kind,
        titleId: tool.titleId,
        description: tool.description,
        scope: tool.scope,
        mcpAnnotations: tool.mcpAnnotations,
        isEnabled: !disabled.has(tool.code),
      }),
    ),
  };
});

// ---- MCP clients ----------------------------------------------------------

function findClient(state: MockState, id: string): McpClient {
  const client = state.clients.find((entry) => entry.id === id);
  if (!client)
    throw new ApiError(404, "NOT_FOUND", "Klien MCP tidak ditemukan.");
  return client;
}

function replaceClient(state: MockState, next: McpClient): McpClient {
  const parsed = mcpClientSchema.parse(next);
  store.set({
    ...state,
    clients: state.clients.map((entry) =>
      entry.id === parsed.id ? parsed : entry,
    ),
  });
  return parsed;
}

registerMock(listMcpClients, ({ query, scenario }) => {
  const rows = store
    .get()
    .clients.filter(
      (client) => query.status === undefined || client.status === query.status,
    );
  return paginateFixture(rows, query, (client) => client.id, scenario);
});

registerMock(approveMcpClient, ({ params, body }) => {
  const state = store.get();
  const client = findClient(state, params.mcpClientId);
  if (client.status !== "pending")
    throw new ApiError(
      409,
      "CONFLICT",
      "Klien ini sudah diproses. Muat ulang daftar klien.",
    );
  const scopes = body.allowedScopes ?? client.allowedScopes;
  if (!isScopeSubset(scopes, client.allowedScopes))
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Akses yang disetujui tidak boleh melebihi yang diminta klien.",
    );
  return {
    data: replaceClient(state, {
      ...client,
      allowedScopes: scopes,
      status: "approved",
      approvedBy: ACTOR,
      approvedAt: now(),
    }),
  };
});

registerMock(revokeMcpClient, ({ params }) => {
  const state = store.get();
  const client = findClient(state, params.mcpClientId);
  if (client.status === "revoked")
    throw new ApiError(
      409,
      "CONFLICT",
      "Klien ini sudah dicabut. Muat ulang daftar klien.",
    );
  return {
    data: replaceClient(state, {
      ...client,
      status: "revoked",
      revokedAt: now(),
    }),
  };
});
