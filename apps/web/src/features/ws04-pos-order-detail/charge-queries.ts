// Query keys and options of the charge screen. Every key carries the outlet so
// a cashier who switches outlet never reads another outlet's charge.
import { queryOptions } from "@tanstack/react-query";
import { fetchChargeTerminals, fetchIssueCharge } from "./charge-api";
import { chargePollMs } from "./charge-method-logic";

export const issueChargeKeys = {
  all: ["pos-order-detail"] as const,
  charge: (outletId: string, chargeId: string) =>
    ["pos-order-detail", outletId, "charge", chargeId] as const,
  terminals: (outletId: string) =>
    ["pos-order-detail", outletId, "charge-terminals"] as const,
};

export const chargeTerminalsQuery = (outletId: string) =>
  queryOptions({
    queryKey: issueChargeKeys.terminals(outletId),
    queryFn: () => fetchChargeTerminals(outletId),
    retry: false,
  });

export const issueChargeQuery = (outletId: string, chargeId: string) =>
  queryOptions({
    queryKey: issueChargeKeys.charge(outletId, chargeId),
    queryFn: ({ signal }) => fetchIssueCharge(chargeId, signal),
    // Money may be on its way: keep asking until the server says otherwise.
    refetchInterval: (query) => chargePollMs(query.state.data),
    refetchIntervalInBackground: false,
    // A returning cashier always sees the server's state, not a cached one.
    staleTime: 0,
    retry: false,
  });
