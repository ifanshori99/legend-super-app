// The data door of the open orders screen (and of the order detail's paid-link
// check): components import these hooks and never touch the endpoints.
import { useQuery } from "@tanstack/react-query";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { openOrdersQuery, parkedOrdersQuery } from "./queries";

function useOutlet(): { outletId: string; enabled: boolean } {
  const outletId = useTenantContext().outlet?.id ?? "";
  return { outletId, enabled: API_MOCK || outletId !== "" };
}

export function useOpenOrders() {
  const { outletId, enabled } = useOutlet();
  return useQuery({ ...openOrdersQuery(outletId), enabled });
}

export function useParkedOrders() {
  const { outletId, enabled } = useOutlet();
  return useQuery({ ...parkedOrdersQuery(outletId), enabled });
}
