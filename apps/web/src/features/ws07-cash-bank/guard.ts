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
