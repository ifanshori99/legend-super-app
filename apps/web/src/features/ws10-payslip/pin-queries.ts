// Query keys and options for the payslip PIN status (bead legend-ilzrj).
// Nested under `payslipKeys.all` so a PIN change can invalidate it by prefix.
import { queryOptions } from "@tanstack/react-query";
import { fetchPayslipPinStatus } from "./pin-api.ts";
import { payslipKeys } from "./queries.ts";

export const payslipPinKeys = {
  status: () => [...payslipKeys.all, "pin-status"] as const,
};

/** Whether the employee has a PIN, and until when it is locked. */
export function payslipPinStatusQuery() {
  return queryOptions({
    queryKey: payslipPinKeys.status(),
    queryFn: ({ signal }) => fetchPayslipPinStatus(signal),
    // The lock clock and a reset by HR change this; never serve it stale.
    staleTime: 0,
  });
}
