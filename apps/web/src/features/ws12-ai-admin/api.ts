// One typed caller per AI & MCP admin endpoint (docs/frontend.md "Add a
// feature's UI"). Components use the hooks in ./hooks.ts, which own cache keys
// and invalidation. The mock in ./mock.ts serves the same contracts when
// VITE_API_MOCK=true.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  approveMcpClient as approveMcpClientEndpoint,
  getAiGovernanceSettings as getAiGovernanceSettingsEndpoint,
  getAiTenantUsage as getAiTenantUsageEndpoint,
  listAiGovernanceTools as listAiGovernanceToolsEndpoint,
  listMcpClients as listMcpClientsEndpoint,
  listMcpTokens as listMcpTokensEndpoint,
  revokeMcpClient as revokeMcpClientEndpoint,
  updateAiGovernanceSettings as updateAiGovernanceSettingsEndpoint,
  type McpTokenSummary,
} from "@starter/shared/ai";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const fetchGovernance = (signal?: AbortSignal) =>
  callEndpoint(getAiGovernanceSettingsEndpoint, undefined, { signal });

export const saveGovernance = (
  body: Body<typeof updateAiGovernanceSettingsEndpoint>,
) => callEndpoint(updateAiGovernanceSettingsEndpoint, { body });

export const fetchGovernanceTools = (signal?: AbortSignal) =>
  callEndpoint(listAiGovernanceToolsEndpoint, undefined, { signal });

/** The current month's budget (no month asked = the current month). */
export const fetchTenantBudget = (signal?: AbortSignal) =>
  callEndpoint(getAiTenantUsageEndpoint, { query: {} }, { signal });

export const fetchMcpClients = (signal?: AbortSignal) =>
  callEndpoint(listMcpClientsEndpoint, { query: { limit: 100 } }, { signal });

export const approveClient = (
  params: Params<typeof approveMcpClientEndpoint>,
  body: Body<typeof approveMcpClientEndpoint>,
) => callEndpoint(approveMcpClientEndpoint, { params, body });

export const revokeClient = (
  params: Params<typeof revokeMcpClientEndpoint>,
  body: Body<typeof revokeMcpClientEndpoint>,
) => callEndpoint(revokeMcpClientEndpoint, { params, body });

/** Safety stop: a tenant never has more than this many pages of live tokens. */
const TOKEN_PAGES_MAX = 20;

/**
 * Every active token of the tenant, following the cursor. The revoke dialog
 * counts tokens and users from this list, so a first page alone could
 * understate what a revoke ends.
 */
export async function fetchAllTenantTokens(
  signal?: AbortSignal,
): Promise<McpTokenSummary[]> {
  const tokens: McpTokenSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < TOKEN_PAGES_MAX; page += 1) {
    const result = await callEndpoint(
      listMcpTokensEndpoint,
      {
        query: {
          scope: "tenant",
          includeInactive: "false",
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    );
    tokens.push(...result.data);
    if (result.meta.nextCursor === null) return tokens;
    cursor = result.meta.nextCursor;
  }
  throw new Error("Too many token pages: the count would be incomplete.");
}
