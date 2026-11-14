import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { outletsQuery } from "@/features/ws07-accounting/queries";
import { FinanceExceptionsPage } from "@/features/ws07-finance-exceptions/components/finance-exceptions-page";
import {
  FINANCE_EXCEPTION_KINDS,
  isMockScenarioRequest,
  resolveFilters,
  toSearch,
  validateRange,
  type FinanceExceptionFilters,
} from "@/features/ws07-finance-exceptions/lib";
import { financeExceptionsQuery } from "@/features/ws07-finance-exceptions/queries";

// /kelola/akuntansi/pengecualian — finance exceptions (legend-4oclu). The
// filters live in the URL: kind, outletId, from, to (business dates; the last
// 14 days in Jakarta when absent). A malformed part falls back to its default.
const dateSearch = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

export const Route = createFileRoute("/_kelola/kelola/akuntansi/pengecualian")({
  validateSearch: z.object({
    kind: z.enum(FINANCE_EXCEPTION_KINDS).optional().catch(undefined),
    outletId: z.uuid().optional().catch(undefined),
    from: dateSearch,
    to: dateSearch,
  }),
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loaderDeps: ({ search }) => search,
  // The list is prefetched, not ensured: a refusal or a failure shows in the
  // page's own error state instead of replacing the whole screen.
  loader: ({ context, location, deps }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    const filters = resolveFilters(deps);
    return Promise.all([
      context.queryClient.ensureQueryData(outletsQuery()),
      validateRange(filters.from, filters.to) === null
        ? Promise.all([
            context.queryClient.prefetchQuery(financeExceptionsQuery(filters)),
            // The cards ask without `kind`; same query when none is set.
            context.queryClient.prefetchQuery(
              financeExceptionsQuery({
                ...(filters.outletId ? { outletId: filters.outletId } : {}),
                from: filters.from,
                to: filters.to,
              }),
            ),
          ])
        : undefined,
    ]);
  },
  component: FinanceExceptionsRoute,
});

function FinanceExceptionsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const filters = resolveFilters(search);
  return (
    <AccountingPage active="exceptions">
      <FinanceExceptionsPage
        filters={filters}
        onApply={(next: FinanceExceptionFilters) => {
          void navigate({ search: () => toSearch(next), replace: true });
        }}
        onReset={() => {
          void navigate({ search: () => ({}), replace: true });
        }}
      />
    </AccountingPage>
  );
}
