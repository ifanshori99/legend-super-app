// The data door of the order detail screen: components import these hooks and
// never touch the endpoints or the mock.
import { useQuery } from "@tanstack/react-query";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { kitchenVoidsQuery, orderQuery } from "./queries";

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

function useReady(orderId: string): { outletId: string; enabled: boolean } {
  const outletId = useOutletId();
  return { outletId, enabled: (API_MOCK || outletId !== "") && orderId !== "" };
}

export function useOrderDetail(orderId: string) {
  const { outletId, enabled } = useReady(orderId);
  return useQuery({ ...orderQuery(outletId, orderId), enabled });
}

export function useKitchenVoids(orderId: string) {
  const { outletId, enabled } = useReady(orderId);
  return useQuery({ ...kitchenVoidsQuery(outletId, orderId), enabled });
}
