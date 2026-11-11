// One typed caller per usage-page endpoint (docs/frontend.md "Add a feature's
// UI"). Components use the hooks in ./usage-hooks.ts, which own cache keys and
// invalidation. The mock in ./usage-mock.ts serves the same contracts when
// VITE_API_MOCK=true.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getAiTenantUsage as getAiTenantUsageEndpoint,
  listAiToolCalls as listAiToolCallsEndpoint,
  listMcpTokens as listMcpTokensEndpoint,
  revokeMcpToken as revokeMcpTokenEndpoint,
} from "@starter/shared/ai";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const fetchAiTenantUsage = (
  query: Query<typeof getAiTenantUsageEndpoint>,
  signal?: AbortSignal,
) => callEndpoint(getAiTenantUsageEndpoint, { query }, { signal });

export const fetchMcpTokens = (
  query: Query<typeof listMcpTokensEndpoint>,
  signal?: AbortSignal,
) => callEndpoint(listMcpTokensEndpoint, { query }, { signal });

export const fetchAiToolCalls = (
  query: Query<typeof listAiToolCallsEndpoint>,
  signal?: AbortSignal,
) => callEndpoint(listAiToolCallsEndpoint, { query }, { signal });

/** Takes effect within MCP_REVOCATION_MAX_SECONDS (MCP-02). */
export const postRevokeMcpToken = (
  params: Params<typeof revokeMcpTokenEndpoint>,
  body: Body<typeof revokeMcpTokenEndpoint>,
) => callEndpoint(revokeMcpTokenEndpoint, { params, body });
