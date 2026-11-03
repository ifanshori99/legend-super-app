// Profile tab "Kontrak": PRD v1.7 §3 F24 "Kontrak Kerja" (PKWT/PKWTT, start,
// end, renewal, and the reminder before it expires). The reminder badge uses
// the contract's own `reminderDaysBefore`, the tenant-configured window, rather
// than a number invented here.
import { useT } from "@/components/i18n";
import type { EmploymentContract } from "@starter/shared/hris";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useContracts } from "../hooks";
import {
  DASH,
  LIST_LIMIT,
  businessDateToday,
  contractDaysLeft,
  contractReminderDue,
  formatBusinessDate,
} from "../lib";
import { ContractStatusPill, EmploymentTypeBadge } from "./employee-status";

export function EmployeeContracts({
  employeeId,
  timeZone,
}: {
  employeeId: string;
  /** The employee's home-outlet time zone: "today" for the reminder window. */
  timeZone: string;
}) {
  const t = useT();
  const today = businessDateToday(undefined, timeZone);
  const contractsQuery = useContracts({ employeeId, limit: LIST_LIMIT });
  const rows = contractsQuery.data?.data ?? [];

  const pending = contractsQuery.isPending;
  const failed = contractsQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <DataTableShell
      title={t("employeeMaster.profile.contracts.title")}
      description={t("employeeMaster.profile.contracts.description")}
      state={state}
      onRetry={() => void contractsQuery.refetch()}
      rowCount={rows.length}
      loadingRows={3}
      empty={{
        title: t("employeeMaster.profile.contracts.emptyTitle"),
        description: t("employeeMaster.profile.contracts.emptyHint"),
      }}
    >
      {/* Phones: stacked contract rows. */}
      <ul className="divide-y px-4 md:hidden">
        {rows.map((contract) => (
          <li key={contract.id} className="grid gap-1.5 py-3">
            <div className="flex items-start justify-between gap-2">
              <EmploymentTypeBadge type={contract.type} />
              <ContractStatusPill status={contract.status} />
            </div>
            <p className="text-sm">
              {formatBusinessDate(contract.startDate)}
              {" – "}
              {contract.endDate === null
                ? t("employeeMaster.profile.contracts.permanent")
                : formatBusinessDate(contract.endDate)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ReminderBadge contract={contract} today={today} />
              <span className="text-sm text-muted-foreground">
                <span className="sr-only">
                  {t("employeeMaster.profile.contracts.columns.salary")}:{" "}
                </span>
                {contract.salarySnapshot?.masked ?? (
                  <SalaryHidden
                    label={t("employeeMaster.profile.pii.emptyValue")}
                  />
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Tablet and desktop. */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("employeeMaster.profile.contracts.columns.type")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.contracts.columns.start")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.contracts.columns.end")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.contracts.columns.reminder")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.contracts.columns.salary")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.contracts.columns.status")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((contract) => (
              <TableRow key={contract.id}>
                <TableCell>
                  <EmploymentTypeBadge type={contract.type} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatBusinessDate(contract.startDate)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {contract.endDate === null
                    ? t("employeeMaster.profile.contracts.permanent")
                    : formatBusinessDate(contract.endDate)}
                </TableCell>
                <TableCell>
                  <ReminderBadge contract={contract} today={today} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular">
                  {contract.salarySnapshot?.masked ?? (
                    <SalaryHidden
                      label={t("employeeMaster.profile.pii.emptyValue")}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <ContractStatusPill status={contract.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </DataTableShell>
  );
}

/** HR-03: null salary = not visible to this role, or not recorded. */
function SalaryHidden({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">{DASH}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function ReminderBadge({
  contract,
  today,
}: {
  contract: EmploymentContract;
  today: string;
}) {
  const t = useT();
  if (!contractReminderDue(contract, today))
    return (
      <span className="text-sm text-muted-foreground">
        {t("employeeMaster.profile.contracts.reminderNone")}
      </span>
    );
  const daysLeft = contractDaysLeft(contract, today);
  if (daysLeft === null) return null;
  return (
    <Badge tone="warning">
      {t("employeeMaster.profile.contracts.reminderDue", { days: daysLeft })}
    </Badge>
  );
}
