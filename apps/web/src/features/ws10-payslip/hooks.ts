// Custom hooks of the payslip, kasbon and reimbursement screens: the only way
// components touch their data (docs/frontend.md "Custom hooks"). Mutations
// invalidate only the list they changed; the opened payslip is never stored in
// the query cache, so its amounts disappear when the screen unmounts.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreateLoanInput,
  CreateReimbursementInput,
  ViewPayslipInput,
} from "./api.ts";
import { fetchMyPayslip, submitLoan, submitReimbursement } from "./api.ts";
import {
  loanPagesQuery,
  payslipKeys,
  payslipPagesQuery,
  reimbursementCategoriesQuery,
  reimbursementPagesQuery,
} from "./queries.ts";
import { useHydrated } from "./use-hydrated.ts";

export function useMyPayslips() {
  const hydrated = useHydrated();
  const query = useInfiniteQuery({
    ...payslipPagesQuery(),
    enabled: hydrated,
  });
  return {
    ...query,
    payslips: query.data?.pages.flatMap((page) => page.data) ?? [],
  };
}

export function useMyLoans() {
  const hydrated = useHydrated();
  const query = useInfiniteQuery({ ...loanPagesQuery(), enabled: hydrated });
  return {
    ...query,
    loans: query.data?.pages.flatMap((page) => page.data) ?? [],
  };
}

export function useMyReimbursements() {
  const hydrated = useHydrated();
  const query = useInfiniteQuery({
    ...reimbursementPagesQuery(),
    enabled: hydrated,
  });
  return {
    ...query,
    reimbursements: query.data?.pages.flatMap((page) => page.data) ?? [],
  };
}

export function useReimbursementCategories() {
  const hydrated = useHydrated();
  return useQuery({
    ...reimbursementCategoriesQuery(),
    enabled: hydrated,
  });
}

/** POST /api/hris/me/payslips/:id/view — the PIN is the authorization. */
export function useViewMyPayslip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      payslipId,
      body,
    }: {
      payslipId: string;
      body: ViewPayslipInput;
    }) => fetchMyPayslip(payslipId, body),
    // The mutation keeps its variables (the PIN) and its data (the amounts) in
    // the MutationCache; gcTime 0 drops both as soon as the screen resets or
    // unmounts the observer, instead of the 5-minute default.
    gcTime: 0,
    // viewedAt changed, so the history badge refreshes; the body is not cached.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: payslipKeys.payslips() }),
  });
}

export function useCreateLoan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLoanInput) => submitLoan(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: payslipKeys.loans() }),
  });
}

export function useCreateReimbursement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReimbursementInput) => submitReimbursement(body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: payslipKeys.reimbursements(),
      }),
  });
}
