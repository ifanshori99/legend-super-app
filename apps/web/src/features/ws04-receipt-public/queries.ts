import { queryOptions } from "@tanstack/react-query";
import { fetchPublicReceipt } from "./api.ts";
import { isInvalidLink } from "./lib.ts";

export const publicReceiptKeys = {
  all: ["pos", "public-receipt"] as const,
  one: (token: string) => [...publicReceiptKeys.all, token] as const,
};

export function publicReceiptQuery(token: string) {
  return queryOptions({
    queryKey: publicReceiptKeys.one(token),
    queryFn: ({ signal }) => fetchPublicReceipt(token, signal),
    // An unknown or expired token is a final answer, not a flaky read.
    retry: (count, error) => !isInvalidLink(error) && count < 1,
    staleTime: 60_000,
  });
}
