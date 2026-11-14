// Typed caller of the finance exceptions endpoint. Components never call it
// directly: they use the hooks in ./hooks.ts.
import { callEndpoint } from "@/lib/api/endpoint";
import { listFinanceExceptions } from "./endpoint";
import type { FinanceExceptionFilters } from "./lib";

export async function fetchFinanceExceptions(
  filters: FinanceExceptionFilters,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listFinanceExceptions,
    {
      query: {
        from: filters.from,
        to: filters.to,
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.outletId ? { outletId: filters.outletId } : {}),
      },
    },
    { signal },
  );
}
