// TL-09 get_my_payslip (bead legend-39d.2). Own payslip only: there is no
// employee id or PIN in the input; the employee is `ctx.access.userId`, resolved
// to the caller's own employee row by `loadPayslipSelf` (same gate as the
// payslip screen: permission `self.payslip.view`, own employee).
//
// PIN gate: a PIN typed in the chat would reach the model, so the tool never
// takes one. It answers only when the employee has a payslip PIN set, it is not
// locked, and the employee opened THIS payslip with the PIN on the screen in
// the last 10 minutes (audit `payslip.viewed`, object = payslip, actor = self,
// written only after a correct PIN). Anything else is refused with a message
// that sends the employee to the app. Output carries amounts and component
// lines only: no bank account, no tax id, no employee name.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  AiError,
  getMyPayslipInputSchema,
  type GetMyPayslipOutput,
  type ToolPeriod,
} from "@starter/shared/ai";
import { auditLogs } from "../../../db/schema/core-audit.ts";
import { payrollRuns, payslips } from "../../../db/schema/payroll.ts";
import { payslipPins } from "../../../db/schema/payslip-pin.ts";
import { db } from "../../../db/index.ts";
import { withTenant } from "../../../db/tenant.ts";
import { HttpError } from "../../../lib/http-error.ts";
import { openPayslipCalculation } from "../../hris-payslip.service.ts";
import { loadPayslipSelf, pinStatusOf } from "../../payslip-pin.service.ts";
import type { AiToolHandler } from "../types.ts";
import { forbidden, resolveReach, TOOL_MAX_ROWS } from "./support.ts";

/** How long an on-screen PIN unlock of one payslip stays valid for the tool. */
export const PAYSLIP_TOOL_UNLOCK_MINUTES = 10;

const PIN_REQUIRED_MESSAGE = "Buka slip di aplikasi dengan PIN dulu.";

const pinRequired = (): AiError =>
  new AiError("AI_TOOL_FORBIDDEN", PIN_REQUIRED_MESSAGE);

function lastDayOf(month: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}

export const getMyPayslip: AiToolHandler = async (ctx, raw) => {
  const input = getMyPayslipInputSchema.parse(raw);
  const reach = await resolveReach(ctx, "self.payslip.view", "TL-09");
  const tenantId = reach.context.tenant.tenantId;
  const since = new Date(
    ctx.now.getTime() - PAYSLIP_TOOL_UNLOCK_MINUTES * 60_000,
  );

  const found = await withTenant(db, reach.context, async (tx) => {
    // Own employee row, from the verified user (never from the input).
    const self = await loadPayslipSelf(
      tx,
      reach.context,
      ctx.access.userId,
    ).catch((error: unknown) => {
      // No own employee row / no payslip permission: nothing of their own.
      if (error instanceof HttpError) throw forbidden();
      throw error;
    });

    const [pin] = await tx
      .select({ lockedUntil: payslipPins.lockedUntil })
      .from(payslipPins)
      .where(
        and(
          eq(payslipPins.tenantId, tenantId),
          eq(payslipPins.employeeId, self.employeeId),
        ),
      )
      .limit(1);
    if (!pin || pinStatusOf(pin, ctx.now).status !== "active")
      throw pinRequired();

    const [row] = await tx
      .select({
        id: payslips.id,
        tenantId: payslips.tenantId,
        calculationEncrypted: payslips.calculationEncrypted,
        piiKeyVersion: payslips.piiKeyVersion,
      })
      .from(payslips)
      .innerJoin(
        payrollRuns,
        and(
          eq(payrollRuns.tenantId, payslips.tenantId),
          eq(payrollRuns.id, payslips.payrollRunId),
        ),
      )
      .where(
        and(
          eq(payslips.tenantId, tenantId),
          eq(payslips.employeeId, self.employeeId),
          sql`substr(${payrollRuns.periodEnd}::text, 1, 7) = ${input.payrollMonth}`,
        ),
      )
      .orderBy(desc(payrollRuns.payDate), desc(payslips.id))
      .limit(1);
    // A month without a payslip answers the same as a locked one, so the tool
    // does not reveal which months exist before the PIN was entered.
    if (!row) throw pinRequired();

    const [unlock] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          // Column bound first so audit_logs_retention_idx limits the scan.
          gte(auditLogs.createdAt, since),
          sql`${auditLogs.event}->>'action' = 'payslip.viewed'`,
          sql`${auditLogs.event}->>'objectId' = ${row.id}`,
          sql`${auditLogs.event}->>'actorId' = ${self.actor}`,
          sql`(${auditLogs.event}->>'createdAt')::timestamptz >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .limit(1);
    if (!unlock) throw pinRequired();

    return { id: row.id, calculation: openPayslipCalculation(row) };
  });

  const { calculation } = found;
  const output: GetMyPayslipOutput = {
    payslipId: found.id,
    month: input.payrollMonth,
    grossIdr: calculation.grossIdr,
    deductionsIdr: calculation.deductionsIdr,
    netIdr: calculation.netIdr,
    lines: calculation.lines.slice(0, TOOL_MAX_ROWS).map((line) => ({
      code: line.componentCode,
      label: line.name,
      amountIdr: line.amountIdr,
    })),
    sources: [
      {
        label: `Slip gaji ${input.payrollMonth}`,
        period: {
          from: `${input.payrollMonth}-01`,
          to: lastDayOf(input.payrollMonth),
        } as ToolPeriod,
        finality: "final",
        link: "/karyawan/slip-gaji",
      },
    ],
  };
  return output;
};
