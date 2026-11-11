// Cached usage-page data and the token revoke mutation. Components never call
// apiFetch directly; revoking invalidates every token list.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AiChannel,
  AiToolCallOutcome,
  AiToolCode,
} from "@starter/shared/ai";
import { listMcpTokens } from "@starter/shared/ai";
import { postRevokeMcpToken } from "./usage-api";
import {
  tenantTokensQuery,
  tenantUsageQuery,
  toolCallsQuery,
} from "./usage-queries";

/** "YYYY-MM" of the tenant month to show. */
export function useTenantUsage(month: string) {
  return useQuery(tenantUsageQuery({ month }));
}

/** Every token of the tenant, active or not, so the list can show its state. */
export function useTenantTokens() {
  return useInfiniteQuery(
    tenantTokensQuery({ scope: "tenant", includeInactive: true, limit: 50 }),
  );
}

export type ToolCallFilters = {
  channel?: AiChannel;
  outcome?: AiToolCallOutcome;
  toolCode?: AiToolCode;
};

export function useToolCalls(filters: ToolCallFilters) {
  return useInfiniteQuery(toolCallsQuery({ limit: 20, ...filters }));
}

export function useRevokeMcpToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { tokenId: string; reason?: string }) =>
      postRevokeMcpToken(
        { mcpTokenId: input.tokenId },
        input.reason === undefined ? {} : { reason: input.reason },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listMcpTokens.id] }),
  });
}
