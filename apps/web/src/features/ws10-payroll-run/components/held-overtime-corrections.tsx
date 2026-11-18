// Held overtime corrections of a simulated run (legend-oayhe). The simulate
// response lists every correction the run will NOT pay yet, with the reason in
// plain words. Held amounts are outside the net totals above; the block only
// tells the reviewer what is waiting before they lock. The field is optional:
// an older response without it, or an empty list, renders nothing.
import { TriangleAlert } from "lucide-react";
import type {
  PayrollHeldOvertimeCorrection,
  PayrollOvertimeCorrectionHeldReason,
  PayrollRun,
  PayrollRunEmployeeResult,
} from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import type { DataState } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";

const REASON_LABEL: Record<PayrollOvertimeCorrectionHeldReason, MessageKey> = {
  offboarding: "payrollRun.held.reasonOffboarding",
  employee_ended: "payrollRun.held.reasonEmployeeEnded",
  formula_missing: "payrollRun.held.reasonFormulaMissing",
  approval_unclear: "payrollRun.held.reasonApprovalUnclear",
  source_unreadable: "payrollRun.held.reasonSourceUnreadable",
  overlapping_sources: "payrollRun.held.reasonOverlappingSources",
  deduction_exceeds_paid: "payrollRun.held.reasonDeductionExceedsPaid",
};

// Corrections are only decided at simulate and enforced at lock, so the block
// belongs to the window between them.
const VISIBLE_STATUS: ReadonlySet<string> = new Set([
  "simulated",
  "hr_approved",
  "approved",
]);

export function HeldOvertimeCorrections({
  run,
  rows,
  resultsState,
  canViewSalaries,
}: {
  run: PayrollRun;
  rows: readonly PayrollRunEmployeeResult[];
  resultsState: DataState;
  canViewSalaries: boolean;
}) {
  const t = useT();
  const held = run.heldOvertimeCorrections;
  if (!held || held.length === 0 || !VISIBLE_STATUS.has(run.status))
    return null;

  const names = new Map(rows.map((row) => [row.employeeId, row.employeeName]));
  // Names and amounts are salary-adjacent PII (HR-03): without the permission
  // only the count and the distinct reasons are shown.
  const restrictedReasons = [...new Set(held.map((item) => item.reason))];

  const employeeLabel = (
    employeeId: PayrollHeldOvertimeCorrection["employeeId"],
  ) => {
    const name = names.get(employeeId);
    if (name) return name;
    if (resultsState === "loading") return t("payrollRun.held.employeePending");
    if (resultsState === "error") return t("payrollRun.held.employeeError");
    return t("payrollRun.held.unknownEmployee");
  };

  return (
    <section
      role="status"
      aria-labelledby="held-overtime-title"
      className="grid min-w-0 gap-3 rounded-lg border border-warning/40 bg-warning-subtle p-4"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-warning"
        />
        <div className="grid min-w-0 gap-1">
          <h2 id="held-overtime-title" className="type-title">
            {t("payrollRun.held.title")}
            <span className="ml-2 align-middle text-sm font-normal">
              {t("payrollRun.held.count", { count: held.length })}
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("payrollRun.held.description")}
          </p>
        </div>
      </div>
      {canViewSalaries ? (
        <ul className="grid gap-2">
          {held.map((item) => (
            <li
              key={`${item.employeeId}:${item.sourceRunId}`}
              className="grid min-w-0 gap-1 rounded-md bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
            >
              <div className="min-w-0">
                <p className="font-semibold break-words">
                  {employeeLabel(item.employeeId)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(REASON_LABEL[item.reason])}
                </p>
              </div>
              <p className="grid gap-0.5 text-sm sm:text-right">
                {item.outstandingIdr === null ? (
                  <span className="text-muted-foreground">
                    {t("payrollRun.held.amountUnknown")}
                  </span>
                ) : item.outstandingIdr === 0 ? null : (
                  <>
                    <span className="text-muted-foreground">
                      {item.outstandingIdr > 0
                        ? t("payrollRun.held.amountOwed")
                        : t("payrollRun.held.amountDeducted")}
                    </span>
                    <Money
                      amount={Math.abs(item.outstandingIdr)}
                      className="font-semibold"
                    />
                    <span className="text-xs text-muted-foreground">
                      {t("payrollRun.held.amountNotApplied")}
                    </span>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <ul className="grid gap-2">
            {restrictedReasons.map((reason) => (
              <li
                key={reason}
                className="rounded-md bg-background p-3 text-sm text-muted-foreground"
              >
                {t(REASON_LABEL[reason])}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {t("payrollRun.held.restrictedNote")}
          </p>
        </>
      )}
    </section>
  );
}
