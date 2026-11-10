// HR resets an employee's payslip PIN (bead legend-ilzrj; payroll.run). The
// API clears the PIN and its lock; HR never sees or sets a PIN, and the
// employee creates a new one. The response only carries the new status.
import type { z } from "zod";
import type { PayslipPinStatus } from "@starter/shared/hris/payroll";
import { resetEmployeePayslipPin } from "@starter/shared/hris/payroll";
import { callEndpoint } from "@/lib/api/endpoint";

export type ResetPayslipPinBody = z.input<typeof resetEmployeePayslipPin.body>;

export async function resetPayslipPin(
  employeeId: string,
  body: ResetPayslipPinBody,
): Promise<PayslipPinStatus> {
  const response = await callEndpoint(resetEmployeePayslipPin, {
    params: { employeeId },
    body,
  });
  return response.data;
}
