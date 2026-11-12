// Preview of what the client asks for, and the approve call. Components never
// call apiFetch directly.
import { useMutation, useQuery } from "@tanstack/react-query";
import { approveMcpAccess } from "./api";
import { buildAuthorizeBody, type ConsentQuery } from "./logic";
import { mcpPreviewQuery } from "./queries";

export function useMcpPreview(query: ConsentQuery | null) {
  return useQuery({
    ...mcpPreviewQuery(query ?? { client_id: "", redirect_uri: "" }),
    enabled: query !== null,
  });
}

export function useApproveMcpAccess() {
  return useMutation({
    mutationFn: (query: ConsentQuery) =>
      approveMcpAccess(buildAuthorizeBody(query)),
  });
}
