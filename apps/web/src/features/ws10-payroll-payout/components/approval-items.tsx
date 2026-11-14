// Payee list of one payout batch: a table from 700px, stacked cards below.
// Shows the net salary the employee receives; the PT fee never appears here
// as a deduction. Also holds the helpers the status tab reuses.
import { CircleAlert } from "lucide-react";
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
import { bankCodeLabel, excludedReasonKey } from "../lib";
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

type SnapshotFields = Pick<
  PayrollDisbursementItemDto,
  "channel" | "accountHolderName" | "maskedAccountNumber"
>;

/**
 * A bank item whose payee account was not locked into the batch (a legacy
 * batch). Cash items never carry an account, so they are not affected.
 */
export function lacksAccountSnapshot(item: SnapshotFields): boolean {
  return (
    item.channel !== "cash" &&
    (item.accountHolderName === null || item.maskedAccountNumber === null)
  );
}

/**
 * Name, subtitle and bank line of an item's employee. The account line comes
 * from the payee snapshot locked into the batch (never the live HR profile),
 * so the approver sees exactly where the money goes. `missingSnapshot` marks a
 * bank item without that snapshot.
 */
export function useEmployeeLine() {
  const t = useT();
  const employees = usePayoutEmployees();
  return (
    item: Pick<PayrollDisbursementItemDto, "employeeId" | "bankCode"> &
      Partial<SnapshotFields>,
  ) => {
    const found = employees.get(item.employeeId);
    const bankName = bankCodeLabel(item.bankCode);
    const missingSnapshot =
      item.channel !== undefined &&
      lacksAccountSnapshot({
        channel: item.channel,
        accountHolderName: item.accountHolderName ?? null,
        maskedAccountNumber: item.maskedAccountNumber ?? null,
      });
    let bank: string;
    if (missingSnapshot) bank = t("payrollPayoutReview.common.noSnapshot");
    else if (item.accountHolderName && item.maskedAccountNumber)
      bank = [item.accountHolderName, item.maskedAccountNumber, bankName]
        .filter(Boolean)
        .join(" · ");
    else bank = t("payrollPayoutReview.common.noAccount");
    return {
      name: found?.name ?? t("payrollPayoutReview.common.unknownEmployee"),
      subtitle: found?.subtitle ?? "",
      bank,
      missingSnapshot,
    };
  };
}

/** Account text; a missing snapshot gets a warning mark, not colour alone. */
function AccountLine({ text, missing }: { text: string; missing: boolean }) {
  if (!missing) return <>{text}</>;
  return (
    <span
      data-testid="payout-no-snapshot"
      className="inline-flex items-center gap-1.5 font-medium text-warning"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}

// Grey band header, small caps (the mockup's recipient table).
const HEAD_CLASS =
  "h-10 bg-surface-2 text-xs font-semibold tracking-wide uppercase";

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
              <TableHead className={HEAD_CLASS}>
                {t("payrollPayoutReview.approval.table.employee")}
              </TableHead>
              <TableHead className={HEAD_CLASS}>
                {t("payrollPayoutReview.approval.table.account")}
              </TableHead>
              <TableHead className={`${HEAD_CLASS} text-right`}>
                {t("payrollPayoutReview.approval.table.amount")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const who = line(item);
              return (
                <TableRow key={item.id} className="h-[70px]">
                  <TableCell className="py-4">
                    <p className="font-semibold">{who.name}</p>
                    {who.subtitle && (
                      <p className="text-sm text-muted-foreground">
                        {who.subtitle}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="tabular py-4">
                    <AccountLine
                      text={who.bank}
                      missing={who.missingSnapshot}
                    />
                  </TableCell>
                  <TableCell className="py-4 text-right">
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
          const who = line(item);
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
                <span className="tabular text-foreground">
                  <AccountLine text={who.bank} missing={who.missingSnapshot} />
                </span>
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
            <span className="font-medium">
              {
                line({ employeeId: item.employeeId, bankCode: item.bankCode })
                  .name
              }
            </span>
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
