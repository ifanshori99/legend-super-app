import { queryOptions } from "@tanstack/react-query";
import type { MemberPointsRedeemStatusInput } from "@starter/shared/crm";
import { memberKeys } from "../ws08-member/queries";
import {
  fetchMemberOpenBills,
  fetchMemberPointsQuote,
  fetchRedeemStatus,
} from "./api";

// Under `memberKeys.all`, so anything that invalidates the member data (a
// reward redemption, a consumed points QR) also refreshes bills and quotes.
export const memberTukarPoinKeys = {
  all: [...memberKeys.all, "tukar-poin"] as const,
  openBills: () => [...memberTukarPoinKeys.all, "open-bills"] as const,
  quote: (orderId: string) =>
    [...memberTukarPoinKeys.all, "quote", orderId] as const,
  status: (orderId: string, token: string) =>
    [...memberTukarPoinKeys.all, "status", orderId, token] as const,
};

// A bill and its quote change at the till at any moment: never serve stale.
export function memberOpenBillsQuery() {
  return queryOptions({
    queryKey: memberTukarPoinKeys.openBills(),
    queryFn: ({ signal }) => fetchMemberOpenBills(signal),
    staleTime: 0,
  });
}

export function memberPointsQuoteQuery(orderId: string) {
  return queryOptions({
    queryKey: memberTukarPoinKeys.quote(orderId),
    queryFn: ({ signal }) => fetchMemberPointsQuote(orderId, signal),
    staleTime: 0,
  });
}

export function redeemStatusQuery(input: MemberPointsRedeemStatusInput) {
  return queryOptions({
    queryKey: memberTukarPoinKeys.status(input.orderId, input.token),
    queryFn: ({ signal }) => fetchRedeemStatus(input, signal),
    staleTime: 0,
    gcTime: 0,
  });
}
