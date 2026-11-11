// Cached AI & MCP admin data and mutations. Components never call apiFetch
// directly; each mutation invalidates what it changes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAiGovernanceSettings,
  getAiTenantUsage,
  listAiGovernanceTools,
  listMcpClients,
  listMcpTokens,
  type ApproveMcpClient,
  type RevokeMcpClient,
  type UpdateAiGovernanceSettings,
} from "@starter/shared/ai";
import { approveClient, revokeClient, saveGovernance } from "./api";
import {
  budgetQuery,
  governanceQuery,
  governanceToolsQuery,
  mcpClientsQuery,
  tenantTokensQuery,
} from "./queries";

/** `enabled` keeps a card from calling an endpoint the account may not use. */
export function useGovernance(enabled: boolean) {
  return useQuery({ ...governanceQuery(), enabled });
}

export function useGovernanceTools(enabled: boolean) {
  return useQuery({ ...governanceToolsQuery(), enabled });
}

export function useBudget(enabled: boolean) {
  return useQuery({ ...budgetQuery(), enabled });
}

export function useMcpClients(enabled: boolean) {
  return useQuery({ ...mcpClientsQuery(), enabled });
}

export function useTenantTokens(enabled: boolean) {
  return useQuery({ ...tenantTokensQuery(), enabled });
}

/** PATCH /governance: a partial update; the answer is the whole settings row. */
export function useUpdateGovernance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAiGovernanceSettings) => saveGovernance(body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [getAiGovernanceSettings.id],
        }),
        // Kill switches live in the settings row, and the cap changes the budget.
        queryClient.invalidateQueries({ queryKey: [listAiGovernanceTools.id] }),
        queryClient.invalidateQueries({ queryKey: [getAiTenantUsage.id] }),
      ]),
  });
}

export function useApproveClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; body: ApproveMcpClient }) =>
      approveClient({ mcpClientId: input.clientId }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listMcpClients.id] }),
  });
}

/** Revoking a client ends all its tokens (founder decision Q11). */
export function useRevokeClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; body: RevokeMcpClient }) =>
      revokeClient({ mcpClientId: input.clientId }, input.body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [listMcpClients.id] }),
        queryClient.invalidateQueries({ queryKey: [listMcpTokens.id] }),
      ]),
  });
}
