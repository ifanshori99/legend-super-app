// Query keys and options for the AI & MCP usage page. Keys start with the
// endpoint id so invalidating `[endpoint.id]` refreshes every filter variant.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getAiTenantUsage,
  listAiToolCalls,
  listMcpTokens,
} from "@starter/shared/ai";
import { endpointQueryKey } from "@/lib/api/endpoint";
import {
  fetchAiTenantUsage,
  fetchAiToolCalls,
  fetchMcpTokens,
} from "./usage-api";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// A back-office screen shows its error state instead of retrying silently for
// seven seconds; the ErrorState's "Coba lagi" is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

export const tenantUsageQuery = (query: Query<typeof getAiTenantUsage>) =>
  queryOptions({
    queryKey: endpointQueryKey(getAiTenantUsage, { query }),
    queryFn: ({ signal }) => fetchAiTenantUsage(query, signal),
    ...RETRY,
  });

type TokenFilter = Omit<NonNullable<Query<typeof listMcpTokens>>, "cursor">;

export const tenantTokensQuery = (filter: TokenFilter) =>
  infiniteQueryOptions({
    queryKey: [...endpointQueryKey(listMcpTokens, { query: filter }), "pages"],
    queryFn: ({ pageParam, signal }) =>
      fetchMcpTokens(
        pageParam === undefined ? filter : { ...filter, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    ...RETRY,
  });

type ToolCallFilter = Omit<
  NonNullable<Query<typeof listAiToolCalls>>,
  "cursor"
>;

export const toolCallsQuery = (filter: ToolCallFilter) =>
  infiniteQueryOptions({
    queryKey: [
      ...endpointQueryKey(listAiToolCalls, { query: filter }),
      "pages",
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchAiToolCalls(
        pageParam === undefined ? filter : { ...filter, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    ...RETRY,
  });
