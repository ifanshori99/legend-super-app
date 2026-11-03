// Per-employee review of a simulated run (Alur K step 2, PAYR-01). The change
// against the previous run is the point of the screen: the contract carries
// `previousNetIdr` and `netChangeIdr` per row, so the diff is never recomputed
// with float arithmetic here. Color only reinforces the sign (status tokens).
import { Calculator } from "lucide-react";
import { sumIdr } from "@starter/shared/core";
import type {
  PayrollRun,
  PayrollRunEmployeeResult,
} from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deltaTone, formatSignedRupiah, type DeltaTone } from "../lib";

const DELTA_CLASS: Record<DeltaTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success",
  danger: "text-danger",
};

const FLAG_LABEL: Record<string, MessageKey> = {
  net_change_over_threshold: "payrollRun.review.flagNetChange",
  missing_bank_account: "payrollRun.review.flagMissingBank",
};

// Badge tones, not StatusKind: a flag is a tinted label, not a status pill.
const FLAG_TONE: Record<string, "warning" | "danger"> = {
  net_change_over_threshold: "warning",
  missing_bank_account: "danger",
};

function Flag({ flag }: { flag: string }) {
  const t = useT();
  const key = FLAG_LABEL[flag];
  return (
    <Badge tone={FLAG_TONE[flag] ?? "neutral"}>{key ? t(key) : flag}</Badge>
  );
}

export function EmployeeReviewTable({
  run,
  rows,
  state,
  onRetry,
  canSimulate,
  restricted = false,
  onSimulate,
}: {
  run: PayrollRun;
  rows: readonly PayrollRunEmployeeResult[];
  state: DataState;
  onRetry: () => void;
  canSimulate: boolean;
  /** The visitor lacks payroll.view/payroll.run: no salary rows (HR-03). */
  restricted?: boolean;
  onSimulate: () => void;
}) {
  const t = useT();
  const gross = sumIdr(rows.map((row) => row.grossIdr));
  const deductions = sumIdr(rows.map((row) => row.deductionsIdr));
  const net = sumIdr(rows.map((row) => row.netIdr));
  const budget = run.totals?.netIdr ?? null;
  const reconciles = budget !== null && net === budget;

  return (
    <DataTableShell
      title={t("payrollRun.review.title")}
      description={t("payrollRun.review.description")}
      state={state}
      onRetry={onRetry}
      actions={
        rows.length > 0 && reconciles ? (
          <StatusPill status="success">
            {t("payrollRun.review.reconciles")}
          </StatusPill>
        ) : rows.length > 0 ? (
          <StatusPill status="warning">
            {t("payrollRun.review.mismatch")}
          </StatusPill>
        ) : undefined
      }
      empty={{
        title: restricted
          ? t("payrollRun.review.restrictedTitle")
          : t("payrollRun.review.emptyTitle"),
        description: restricted
          ? t("payrollRun.review.restrictedHint")
          : t("payrollRun.review.emptyHint"),
        action:
          !restricted && canSimulate && run.status === "draft" ? (
            <Button type="button" size="sm" onClick={onSimulate}>
              <Calculator aria-hidden="true" />
              {t("payrollRun.action.simulate")}
            </Button>
          ) : undefined,
      }}
      rowCount={rows.length}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("payrollRun.review.columnEmployee")}</TableHead>
            <TableHead>{t("payrollRun.review.columnPosition")}</TableHead>
            <TableHead numeric>{t("payrollRun.review.columnGross")}</TableHead>
            <TableHead numeric>
              {t("payrollRun.review.columnDeductions")}
            </TableHead>
            <TableHead numeric>{t("payrollRun.review.columnNet")}</TableHead>
            <TableHead numeric>
              {t("payrollRun.review.columnPrevious")}
            </TableHead>
            <TableHead numeric>{t("payrollRun.review.columnDelta")}</TableHead>
            <TableHead>{t("payrollRun.review.columnFlags")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.employeeId}>
              <TableCell>
                <p className="font-semibold">{row.employeeName}</p>
                <p className="text-xs leading-4 text-muted-foreground tabular">
                  {row.employeeNo}
                </p>
              </TableCell>
              <TableCell>
                {row.positionName ?? t("payrollRun.common.none")}
              </TableCell>
              <TableCell numeric>
                <Money amount={row.grossIdr} />
              </TableCell>
              <TableCell numeric>
                <Money amount={row.deductionsIdr} />
              </TableCell>
              <TableCell numeric>
                <Money amount={row.netIdr} />
              </TableCell>
              <TableCell numeric className="text-muted-foreground">
                {row.previousNetIdr === null ? (
                  t("payrollRun.review.noPrevious")
                ) : (
                  <Money amount={row.previousNetIdr} />
                )}
              </TableCell>
              <TableCell numeric>
                {row.netChangeIdr === null ? (
                  <span className="text-muted-foreground">
                    {t("payrollRun.review.noPrevious")}
                  </span>
                ) : (
                  <span
                    className={`font-semibold tabular ${DELTA_CLASS[deltaTone(row.netChangeIdr)]}`}
                  >
                    {formatSignedRupiah(row.netChangeIdr)}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {row.flags.length === 0 ? (
                  <span className="text-muted-foreground">
                    {t("payrollRun.review.noFlags")}
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {row.flags.map((flag) => (
                      <Flag key={flag} flag={flag} />
                    ))}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>
              <span className="flex items-center gap-2">
                {t("payrollRun.review.totalRow")}
                <Badge tone="neutral">
                  <NumberDisplay value={rows.length} />
                </Badge>
              </span>
            </TableCell>
            <TableCell numeric>
              <Money amount={gross} />
            </TableCell>
            <TableCell numeric>
              <Money amount={deductions} />
            </TableCell>
            <TableCell numeric>
              <Money amount={net} />
            </TableCell>
            <TableCell colSpan={3} className="text-sm font-normal">
              {budget === null
                ? t("payrollRun.review.noBudget")
                : t("payrollRun.review.budgetNet", {
                    total: formatRupiah(budget),
                  })}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </DataTableShell>
  );
}
