// Payee list of one payout batch: a table from 700px, stacked cards below.
// Shows the net salary the employee receives; the PT fee never appears here
// as a deduction. Also holds the helpers the status tab reuses.
import type { PayrollDisbursementItemDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { excludedReasonKey } from "../lib";
import { usePayoutEmployees } from "../hooks";

export type PayoutEmployeeMap = ReturnType<typeof usePayoutEmployees>;

/** An item is paid out unless the server excluded or cancelled it. */
export function isPayableItem(item: PayrollDisbursementItemDto): boolean {
  return (
    item.excludedReason === null &&
    item.status !== "blocked" &&
    item.status !== "cancelled"
  );
}

export function isExcludedItem(item: PayrollDisbursementItemDto): boolean {
  return item.excludedReason !== null || item.status === "blocked";
}

export function useEmployeeLine() {
  const t = useT();
  const employees = usePayoutEmployees();
  return (employeeId: string) => {
    const found = employees.get(employeeId);
    return {
      name: found?.name ?? t("payrollPayoutReview.common.unknownEmployee"),
      subtitle: found?.subtitle ?? "",
      bank: found?.bankLabel ?? t("payrollPayoutReview.common.noAccount"),
    };
  };
}

export function PayeeTable({
  items,
}: {
  items: readonly PayrollDisbursementItemDto[];
}) {
  const t = useT();
  const line = useEmployeeLine();
  return (
    <>
      <div className="hidden min-[700px]:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("payrollPayoutReview.approval.table.employee")}
              </TableHead>
              <TableHead>
                {t("payrollPayoutReview.approval.table.account")}
              </TableHead>
              <TableHead className="text-right">
                {t("payrollPayoutReview.approval.table.amount")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const who = line(item.employeeId);
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <p className="font-semibold">{who.name}</p>
                    {who.subtitle && (
                      <p className="text-xs text-muted-foreground">
                        {who.subtitle}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="tabular">{who.bank}</TableCell>
                  <TableCell className="text-right">
                    <Money amount={item.amountIdr} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="grid min-[700px]:hidden">
        {items.map((item) => {
          const who = line(item.employeeId);
          return (
            <li
              key={item.id}
              className="grid gap-1 border-b-(length:--border-w) py-3 last:border-b-0"
            >
              <p className="font-semibold">{who.name}</p>
              {who.subtitle && (
                <p className="text-sm text-muted-foreground">{who.subtitle}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {t("payrollPayoutReview.approval.table.accountInline")} ·{" "}
                <span className="tabular text-foreground">{who.bank}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t("payrollPayoutReview.approval.table.amountInline")} ·{" "}
                <Money
                  amount={item.amountIdr}
                  className="font-semibold text-foreground"
                />
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Items the server left out, each with its reason; nothing is paid for them. */
export function ExcludedList({
  items,
  title,
  hint,
}: {
  items: readonly PayrollDisbursementItemDto[];
  title: string;
  hint: string;
}) {
  const t = useT();
  const line = useEmployeeLine();
  if (items.length === 0) return null;
  return (
    <section
      aria-label={title}
      data-testid="payout-excluded"
      className="grid gap-2 rounded-container border-(length:--border-w) bg-warning-subtle p-3"
    >
      <p className="text-sm font-semibold text-warning">{title}</p>
      <p className="text-sm text-foreground">{hint}</p>
      <ul className="grid gap-1 text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap justify-between gap-x-3">
            <span className="font-medium">{line(item.employeeId).name}</span>
            <span className="text-foreground">
              {item.excludedReason
                ? t(excludedReasonKey(item.excludedReason))
                : t("payrollPayoutReview.common.noReason")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
