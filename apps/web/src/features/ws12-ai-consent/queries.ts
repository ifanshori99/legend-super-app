// Query key and options for the consent preview. Not cached across visits: the
// answer depends on the signed-in user and the client's current approval.
import { queryOptions } from "@tanstack/react-query";
import { fetchMcpPreview } from "./api";
import type { ConsentQuery } from "./logic";

/** A consent screen shows its error state instead of retrying silently. */
export const mcpPreviewQuery = (query: ConsentQuery) =>
  queryOptions({
    queryKey: ["mcp-consent-preview", query] as const,
    queryFn: ({ signal }) => fetchMcpPreview(query, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
