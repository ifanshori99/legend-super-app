// Write guards of the cash in/out and petty cash sections (legend-4961). The
// API re-checks every permission; these only avoid showing a section or an
// action the visitor cannot use. Fails closed without route access.
import { useRouteContext } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";

const CASH_BANK_RECORD: readonly PermissionCode[] = [
  "accounting.cash_bank.record",
];
const CASH_BANK_APPROVE: readonly PermissionCode[] = [
  "accounting.cash_bank.approve",
];
const CASH_BANK_LIMIT_MANAGE: readonly PermissionCode[] = [
  "accounting.cash_bank.limit.manage",
];
const APPROVAL_INBOX_VIEW: readonly PermissionCode[] = ["approval.inbox.view"];
const PETTY_CASH_MANAGE: readonly PermissionCode[] = [
  "accounting.petty_cash.manage",
];

function useHolds(codes: readonly PermissionCode[]): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access ? holdsAny(context.access, codes) : false;
}

/** Cash in, cash out and transfers (legal-entity level). */
export function useCanRecordCashBank(): boolean {
  return useHolds(CASH_BANK_RECORD);
}

/** Petty cash funds: view, top up, return and retry a parked journal. */
export function useCanManagePettyCash(): boolean {
  return useHolds(PETTY_CASH_MANAGE);
}

/** Approve or reject a cash out above the limit (never your own). */
export function useCanApproveCashBank(): boolean {
  return useHolds(CASH_BANK_APPROVE);
}

/** Change the cash out approval limit. */
export function useCanManageCashApprovalLimit(): boolean {
  return useHolds(CASH_BANK_LIMIT_MANAGE);
}

/** The approval inbox a pending cash out is approved in (legend-fukt6). */
export function useCanViewApprovalInbox(): boolean {
  return useHolds(APPROVAL_INBOX_VIEW);
}
