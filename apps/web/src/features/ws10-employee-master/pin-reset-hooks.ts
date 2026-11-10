// Hook for the HR "Reset PIN" dialog (bead legend-ilzrj). The reason is 3-500
// characters; the key is minted once per dialog attempt by the caller.
import { useMutation } from "@tanstack/react-query";
import type { ResetPayslipPinBody } from "./pin-reset-api.ts";
import { resetPayslipPin } from "./pin-reset-api.ts";

/** POST /api/hris/employees/:employeeId/payslip-pin/reset. */
export function useResetPayslipPin() {
  return useMutation({
    mutationFn: ({
      employeeId,
      body,
    }: {
      employeeId: string;
      body: ResetPayslipPinBody;
    }) => resetPayslipPin(employeeId, body),
  });
}
