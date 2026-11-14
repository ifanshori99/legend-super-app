// The only way components touch finance exceptions data.
import { useQuery } from "@tanstack/react-query";
import { financeExceptionsQuery } from "./queries";
import type { FinanceExceptionFilters } from "./lib";

export function useFinanceExceptions(filters: FinanceExceptionFilters) {
  return useQuery(financeExceptionsQuery(filters));
}

/**
 * The summary cards: the same filters minus `kind`. The API summarises only
 * the kind it was asked for, so the cards would read "no events" for every
 * other kind while one card is selected. With no kind set this is the same
 * query (same key) as the list: one request.
 */
export function useFinanceExceptionsSummary(filters: FinanceExceptionFilters) {
  return useQuery(
    financeExceptionsQuery({
      ...(filters.outletId ? { outletId: filters.outletId } : {}),
      from: filters.from,
      to: filters.to,
    }),
  );
}
