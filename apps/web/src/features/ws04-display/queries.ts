import { queryOptions } from "@tanstack/react-query";
import { fetchCustomerDisplayState } from "./api.ts";
import { displayRefetchMs } from "./lib.ts";

// The display is a live view of the terminal (PRD §3 F11): it polls while it
// is open, and reads again the moment the dynamic QRIS expires so the customer
// never scans a dead code (PRD §3 F13). The edge push feed (WS-04 BE) replaces
// the poll later; the screen already treats every read as a full snapshot.
export const customerDisplayKeys = {
  all: ["pos", "customer-display"] as const,
  state: (terminalDeviceId?: string) =>
    [...customerDisplayKeys.all, "state", terminalDeviceId ?? null] as const,
};

export function customerDisplayQuery(terminalDeviceId?: string) {
  return queryOptions({
    queryKey: customerDisplayKeys.state(terminalDeviceId),
    queryFn: ({ signal }) =>
      fetchCustomerDisplayState(terminalDeviceId, signal),
    refetchInterval: (query) =>
      displayRefetchMs(query.state.data ?? null, Date.now()),
    refetchIntervalInBackground: true,
  });
}
