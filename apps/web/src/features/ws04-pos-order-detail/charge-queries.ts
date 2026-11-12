// Query keys and options of the charge screen. Every key carries the outlet so
// a cashier who switches outlet never reads another outlet's charge.
import { queryOptions } from "@tanstack/react-query";
import { fetchIssueCharge } from "./charge-api";

export const issueChargeKeys = {
  all: ["pos-order-detail"] as const,
  charge: (outletId: string, chargeId: string) =>
    ["pos-order-detail", outletId, "charge", chargeId] as const,
};

export const issueChargeQuery = (outletId: string, chargeId: string) =>
  queryOptions({
    queryKey: issueChargeKeys.charge(outletId, chargeId),
    queryFn: ({ signal }) => fetchIssueCharge(chargeId, signal),
    retry: false,
  });
