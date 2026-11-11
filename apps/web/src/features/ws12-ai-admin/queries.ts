// Query keys and options for the AI & MCP admin page. Every key starts with
// the endpoint id, so invalidating `[endpoint.id]` refreshes every variant
// (the usage page invalidates `[listMcpTokens.id]` after a token revoke and
// the counts here follow).
import {
  getAiGovernanceSettings,
  getAiTenantUsage,
  listAiGovernanceTools,
  listMcpClients,
  listMcpTokens,
} from "@starter/shared/ai";
import {
  fetchAllTenantTokens,
  fetchGovernance,
  fetchGovernanceTools,
  fetchMcpClients,
  fetchTenantBudget,
} from "./api";

// An admin card shows its error state instead of retrying silently for
// seven seconds; the ErrorState's "Coba lagi" is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

export const governanceQuery = () => ({
  queryKey: [getAiGovernanceSettings.id] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchGovernance(signal),
  ...RETRY,
});

export const governanceToolsQuery = () => ({
  queryKey: [listAiGovernanceTools.id] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    fetchGovernanceTools(signal),
  ...RETRY,
});

export const budgetQuery = () => ({
  queryKey: [getAiTenantUsage.id, { current: true }] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchTenantBudget(signal),
  ...RETRY,
});

export const mcpClientsQuery = () => ({
  queryKey: [listMcpClients.id, { limit: 100 }] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchMcpClients(signal),
  ...RETRY,
});

export const tenantTokensQuery = () => ({
  queryKey: [
    listMcpTokens.id,
    { scope: "tenant", pages: "all", active: true },
  ] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    fetchAllTenantTokens(signal),
  ...RETRY,
});
