// Query and mutation hooks of the account-role mapping screen (legend-fzvh).
// Keys sit under accountingKeys.all so one accounting invalidation refreshes
// them too; the screen reads the chart through the shared `useAccounts`.
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  fetchAccountMappings,
  replaceAccountMappings,
  type ReplaceMappingsBody,
} from "./mapping-api";
import { accountingKeys } from "./queries";

export const accountMappingKeys = {
  list: (legalEntityId: string) =>
    [...accountingKeys.all, "account-mappings", legalEntityId] as const,
};

export function accountMappingsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: accountMappingKeys.list(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchAccountMappings(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}

export function useAccountMappings(legalEntityId: string | undefined) {
  return useQuery(accountMappingsQuery(legalEntityId));
}

export function useReplaceAccountMappings(legalEntityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ReplaceMappingsBody) =>
      replaceAccountMappings(legalEntityId, body),
    onSuccess: (rows) => {
      queryClient.setQueryData(accountMappingKeys.list(legalEntityId), rows);
      return queryClient.invalidateQueries({
        queryKey: accountMappingKeys.list(legalEntityId),
      });
    },
  });
}
