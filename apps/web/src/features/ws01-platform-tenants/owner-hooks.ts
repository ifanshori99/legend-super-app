// Hooks of the tenant Owner screen (legend-be0lx). The platform contract has
// no read endpoint for a tenant's Owner assignments, so the Owner this screen
// shows is the one set in this browser session (query cache, memory only).
// When a list endpoint exists, replace `ownerQueryFn` with the real read.
import type { TenantId, UserId } from "@starter/shared/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleAssignmentId } from "@starter/shared/access";
import * as api from "./owner-api";
import {
  ownerFromResult,
  type OwnerAccountOption,
  type OwnerFormMode,
  type OwnerSummary,
} from "./owner-state";

const ownerKey = (tenantId: string) =>
  ["platform-tenant-owner", tenantId] as const;

// No endpoint to read from yet: unknown owner reads as "none known".
const ownerQueryFn = async (): Promise<OwnerSummary | null> => null;

export function useTenantOwner(tenantId: string) {
  return useQuery({
    queryKey: ownerKey(tenantId),
    queryFn: ownerQueryFn,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export type SaveOwnerInput = {
  mode: OwnerFormMode;
  /** Required for "replace": the assignment being replaced. */
  assignmentId: string | null;
  userId: string;
  option: OwnerAccountOption | null;
  reason: string;
  mfaCode: string;
};

export function useSaveTenantOwner(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveOwnerInput) => {
      const params = { tenantId: tenantId as TenantId };
      const body = {
        account: { userId: input.userId as UserId },
        reason: input.reason,
        mfaCode: input.mfaCode,
      };
      const result =
        input.mode === "replace"
          ? await api.replaceTenantOwner(
              {
                ...params,
                assignmentId: input.assignmentId as RoleAssignmentId,
              },
              body,
            )
          : await api.assignTenantOwner(params, body);
      return { data: result.data, option: input.option };
    },
    onSuccess: ({ data, option }) => {
      queryClient.setQueryData(
        ownerKey(tenantId),
        ownerFromResult(data, option),
      );
    },
  });
}
