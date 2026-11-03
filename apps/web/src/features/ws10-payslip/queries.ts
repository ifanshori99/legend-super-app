// Query keys and options for the employee payslip, kasbon and reimbursement
// screens (bead legend-23nc). Hierarchical under "payslip" so a mutation can
// invalidate exactly one list (docs/frontend.md "Query options and keys").
//
// Nothing here caches a payslip body: `viewMyPayslip` is a PIN-gated mutation
// and the screen keeps the opened payslip in component state only, so leaving
// the page asks for the PIN again (PRD §3 D.30).

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  fetchMyLoans,
  fetchMyPayslips,
  fetchMyReimbursements,
  fetchReimbursementCategories,
} from "./api.ts";

export const PAYSLIP_PAGE_SIZE = 20;

export const payslipKeys = {
  all: ["payslip"] as const,
  payslips: () => [...payslipKeys.all, "payslips"] as const,
  loans: () => [...payslipKeys.all, "loans"] as const,
  reimbursements: () => [...payslipKeys.all, "reimbursements"] as const,
  categories: () => [...payslipKeys.all, "reimbursement-categories"] as const,
};

/** The employee's own payslip history (no amounts, see the contract). */
export function payslipPagesQuery() {
  return infiniteQueryOptions({
    queryKey: payslipKeys.payslips(),
    queryFn: ({ pageParam, signal }) =>
      fetchMyPayslips({ limit: PAYSLIP_PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** The employee's own kasbon requests, newest first. */
export function loanPagesQuery() {
  return infiniteQueryOptions({
    queryKey: payslipKeys.loans(),
    queryFn: ({ pageParam, signal }) =>
      fetchMyLoans({ limit: PAYSLIP_PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** The employee's own reimbursement claims, newest first. */
export function reimbursementPagesQuery() {
  return infiniteQueryOptions({
    queryKey: payslipKeys.reimbursements(),
    queryFn: ({ pageParam, signal }) =>
      fetchMyReimbursements(
        { limit: PAYSLIP_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** Active claim categories and their per-claim limits (tenant data). */
export function reimbursementCategoriesQuery() {
  return queryOptions({
    queryKey: payslipKeys.categories(),
    queryFn: ({ signal }) => fetchReimbursementCategories(signal),
    staleTime: 30 * 60_000,
  });
}
