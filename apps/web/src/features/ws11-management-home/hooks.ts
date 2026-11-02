// The only way components touch the management home's data.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DashboardQuery } from "@starter/shared/dashboard";
import { managementHomeKeys, managementLayoutQuery } from "./queries";

export function useManagementLayout(query: DashboardQuery = {}) {
  return useQuery(managementLayoutQuery(query));
}

/** Pull a fresh layout (the header's "Perbarui" action). */
export function useRefreshManagementLayout() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: managementHomeKeys.all });
}
