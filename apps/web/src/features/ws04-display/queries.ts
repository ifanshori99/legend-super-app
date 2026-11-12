import { queryOptions } from "@tanstack/react-query";
import { fetchCustomerDisplayState, fetchDisplayOrder } from "./api.ts";
import { DISPLAY_POLL_MS, displayRefetchMs } from "./lib.ts";

// The display is a live view of the terminal (PRD §3 F11): it polls while it
// is open, and reads again the moment the dynamic QRIS expires so the customer
// never scans a dead code (PRD §3 F13). The edge push feed (WS-04 BE) replaces
// the poll later; the screen already treats every read as a full snapshot.
export const customerDisplayKeys = {
  all: ["pos", "customer-display"] as const,
  state: (outletId: string, terminalDeviceId?: string) =>
    [
      ...customerDisplayKeys.all,
      "state",
      outletId,
      terminalDeviceId ?? null,
    ] as const,
  order: (outletId: string, orderId: string) =>
    [...customerDisplayKeys.all, "order", outletId, orderId] as const,
};

export function customerDisplayQuery(
  outletId: string,
  terminalDeviceId?: string,
) {
  return queryOptions({
    queryKey: customerDisplayKeys.state(outletId, terminalDeviceId),
    queryFn: ({ signal }) =>
      fetchCustomerDisplayState(outletId, terminalDeviceId, signal),
    refetchInterval: (query) =>
      displayRefetchMs(query.state.data ?? null, Date.now()),
    refetchIntervalInBackground: true,
  });
}

/** The order's own record (deposit), read while its payment is on screen. */
export function displayOrderQuery(outletId: string, orderId: string) {
  return queryOptions({
    queryKey: customerDisplayKeys.order(outletId, orderId),
    queryFn: ({ signal }) => fetchDisplayOrder(outletId, orderId, signal),
    // A deposit is never cached across reads of the screen: the cashier can
    // change the order, so read it again with every poll of the display.
    staleTime: 0,
    refetchInterval: DISPLAY_POLL_MS,
    refetchIntervalInBackground: true,
    retry: 1,
  });
}
