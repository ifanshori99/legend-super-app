// Query key and options of the finance exceptions screen. The key sits under
// "accounting" so one accounting invalidation refreshes it too.
import { queryOptions } from "@tanstack/react-query";
import { accountingKeys } from "@/features/ws07-accounting/queries";
import { fetchFinanceExceptions } from "./api";
import { validateRange, type FinanceExceptionFilters } from "./lib";

export const financeExceptionKeys = {
  list: (filters: FinanceExceptionFilters) =>
    [...accountingKeys.all, "finance-exceptions", filters] as const,
};

/** Disabled while the window is invalid: the API would refuse it anyway. */
export function financeExceptionsQuery(filters: FinanceExceptionFilters) {
  return queryOptions({
    queryKey: financeExceptionKeys.list(filters),
    queryFn: ({ signal }) => fetchFinanceExceptions(filters, signal),
    enabled: validateRange(filters.from, filters.to) === null,
  });
}
