// Typed calls for the employee payslip, kasbon and reimbursement screens
// (bead legend-23nc; PRD v1.7 §3 F30 "Slip Gaji", F31 "Kasbon &
// Reimbursement", HR-01). One function per endpoint of the payroll contract;
// responses are unwrapped so hooks and components never see the `{ data }`
// envelope.
//
// HR-01: every `/api/hris/me/*` route resolves the employee from the signed-in
// session and takes no employee id and no tenant id. The API scopes each read
// to the caller; the FE never passes an id to widen it.

import type { z } from "zod";
import type { CursorPage } from "@starter/shared/core";
import type {
  EmployeeLoan,
  MyPayslipSummary,
  Payslip,
  Reimbursement,
  ReimbursementCategory,
} from "@starter/shared/hris/payroll";
import {
  createMyLoan,
  createMyReimbursement,
  listMyLoans,
  listMyPayslips,
  listMyReimbursements,
  listReimbursementCategories,
  viewMyPayslip,
} from "@starter/shared/hris/payroll";
import { callEndpoint } from "@/lib/api/endpoint";

export type ListQuery = { limit?: number; cursor?: string };
export type CreateLoanInput = z.input<typeof createMyLoan.body>;
export type CreateReimbursementInput = z.input<
  typeof createMyReimbursement.body
>;
export type ViewPayslipInput = z.input<typeof viewMyPayslip.body>;

export async function fetchMyPayslips(
  query: ListQuery,
  signal?: AbortSignal,
): Promise<CursorPage<MyPayslipSummary>> {
  return callEndpoint(listMyPayslips, { query }, { signal });
}

/** Opens one payslip after the PIN check; also sets its `viewedAt`. */
export async function fetchMyPayslip(
  payslipId: string,
  body: ViewPayslipInput,
): Promise<Payslip> {
  const response = await callEndpoint(viewMyPayslip, {
    params: { payslipId },
    body,
  });
  return response.data;
}

export async function fetchMyLoans(
  query: ListQuery,
  signal?: AbortSignal,
): Promise<CursorPage<EmployeeLoan>> {
  return callEndpoint(listMyLoans, { query }, { signal });
}

export async function submitLoan(body: CreateLoanInput): Promise<EmployeeLoan> {
  const response = await callEndpoint(createMyLoan, { body });
  return response.data;
}

export async function fetchMyReimbursements(
  query: ListQuery,
  signal?: AbortSignal,
): Promise<CursorPage<Reimbursement>> {
  return callEndpoint(listMyReimbursements, { query }, { signal });
}

export async function submitReimbursement(
  body: CreateReimbursementInput,
): Promise<Reimbursement> {
  const response = await callEndpoint(createMyReimbursement, { body });
  return response.data;
}

export async function fetchReimbursementCategories(
  signal?: AbortSignal,
): Promise<CursorPage<ReimbursementCategory>> {
  return callEndpoint(
    listReimbursementCategories,
    { query: { limit: 100 } },
    { signal },
  );
}
