// Restore window reads and the restore writes (bead legend-nb4iy). Components
// reach the API only through these hooks.
import type { OutletId, TenantId } from "@starter/shared/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orgEndpoints, platformEndpoints } from "@starter/shared/platform";
import type {
  RestoreOutletInput,
  RestoreTenantInput,
} from "@starter/shared/platform";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import * as api from "./restore-api";

export const tenantRestoreWindowQuery = (tenantId: string) =>
  endpointQueryOptions(platformEndpoints.getTenantRestoreWindow, {
    params: { tenantId: tenantId as TenantId },
  });

export const outletRestoreWindowQuery = (tenantId: string, outletId: string) =>
  endpointQueryOptions(platformEndpoints.getOutletRestoreWindow, {
    params: { tenantId: tenantId as TenantId, outletId: outletId as OutletId },
  });

export const useTenantRestoreWindow = (tenantId: string) =>
  useQuery(tenantRestoreWindowQuery(tenantId));

export const useOutletRestoreWindow = (tenantId: string, outletId: string) =>
  useQuery(outletRestoreWindowQuery(tenantId, outletId));

/** A restore changes the record, its window and every list that shows it. */
function useRefreshAfterRestore() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        platformEndpoints.getTenantRestoreWindow.id,
        platformEndpoints.getOutletRestoreWindow.id,
        platformEndpoints.listTenants.id,
        platformEndpoints.getTenant.id,
        platformEndpoints.getTenantUsage.id,
        orgEndpoints.listOutlets.id,
      ].map((id) => queryClient.invalidateQueries({ queryKey: [id] })),
    );
}

export function useRestoreTenant(tenantId: string) {
  const refresh = useRefreshAfterRestore();
  return useMutation({
    mutationFn: (body: RestoreTenantInput) =>
      api.restoreTenant({ tenantId: tenantId as TenantId }, body),
    onSuccess: () => refresh(),
  });
}

export function useRestoreOutlet(tenantId: string, outletId: string) {
  const refresh = useRefreshAfterRestore();
  return useMutation({
    mutationFn: (body: RestoreOutletInput) =>
      api.restoreOutlet(
        { tenantId: tenantId as TenantId, outletId: outletId as OutletId },
        body,
      ),
    onSuccess: () => refresh(),
  });
}
