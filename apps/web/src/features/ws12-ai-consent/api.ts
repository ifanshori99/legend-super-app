// Typed callers for the MCP consent screen. Components use ./hooks.ts. The mock
// in ./mock.ts serves the same contracts when VITE_API_MOCK=true.
import type { EndpointInput } from "@starter/shared/api";
import { previewMcpAuthorize } from "@starter/shared/ai";
import { callEndpoint } from "@/lib/api/endpoint";
import { authorizeMcp } from "./endpoints";

export const fetchMcpPreview = (
  query: EndpointInput<typeof previewMcpAuthorize>["query"],
  signal?: AbortSignal,
) => callEndpoint(previewMcpAuthorize, { query }, { signal });

export const approveMcpAccess = (
  body: EndpointInput<typeof authorizeMcp>["body"],
) => callEndpoint(authorizeMcp, { body });
