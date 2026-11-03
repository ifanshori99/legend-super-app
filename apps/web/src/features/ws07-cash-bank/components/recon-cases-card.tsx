// Reconciliation cases table (ACC-04): every difference with a PIC and a due
// date. A row opens the case drawer for the actions the contract allows
// (start, reassign, resolve).
import * as React from "react";
import type { ReconciliationCaseStatus } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAssignablePeople } from "@/features/ws01-access/people";
import {
  CASE_STATUS_KEYS,
  CASE_TYPE_KEYS,
  formatDateTime,
  shortId,
} from "../lib";
import { useReconciliationCases } from "../hooks";
import { ReconciliationCaseStatusBadge } from "./status-badges";

const ALL = "all";

const STATUS_FILTERS: readonly (ReconciliationCaseStatus | "all")[] = [
  "all",
  "open",
  "in_progress",
  "resolved",
  "written_off",
];

export function ReconciliationCasesCard({
  legalEntityId,
  onOpenCase,
}: {
  legalEntityId: string;
  onOpenCase: (caseId: string) => void;
}) {
  const t = useT();
  const [statusFilter, setStatusFilter] = React.useState<
    ReconciliationCaseStatus | "all"
  >(ALL);
  const cases = useReconciliationCases(legalEntityId, statusFilter);
  const people = useAssignablePeople();
  const rows = cases.data?.data ?? [];
  const byId = new Map(
    (people.data?.people ?? []).map((person) => [person.id, person.name]),
  );
  const personLabel = (ownerId: string) =>
    byId.get(ownerId) ??
    t("accounting.cash.recon.cases.unknownUser", {
      id: shortId(ownerId),
    });
  const state: DataState = cases.isPending
    ? "loading"
    : cases.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <DataTableShell
      title={t("accounting.cash.recon.cases.title")}
      description={t("accounting.cash.recon.cases.subtitle")}
      state={state}
      onRetry={() => {
        void cases.refetch();
      }}
      rowCount={rows.length}
      actions={
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setStatusFilter(value as ReconciliationCaseStatus | "all")
          }
        >
          <SelectTrigger
            className="h-control-sm w-full sm:w-44"
            aria-label={t("accounting.cash.recon.cases.filterStatus")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((status) => (
              <SelectItem key={status} value={status}>
                {status === "all"
                  ? t("accounting.cash.recon.cases.allStatuses")
                  : t(CASE_STATUS_KEYS[status])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      empty={{
        title: t("accounting.cash.recon.cases.emptyTitle"),
        description: t("accounting.cash.recon.cases.emptyHint"),
      }}
    >
      <Table className="min-w-[48rem]">
        <TableHeader>
          <TableRow>
            <TableHead>
              {t("accounting.cash.recon.cases.columns.opened")}
            </TableHead>
            <TableHead>
              {t("accounting.cash.recon.cases.columns.type")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.cash.recon.cases.columns.difference")}
            </TableHead>
            <TableHead>
              {t("accounting.cash.recon.cases.columns.owner")}
            </TableHead>
            <TableHead>
              {t("accounting.cash.recon.cases.columns.due")}
            </TableHead>
            <TableHead>
              {t("accounting.cash.recon.cases.columns.status")}
            </TableHead>
            <TableHead className="text-right">
              {t("accounting.cash.recon.cases.columns.action")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap tabular text-sm">
                {formatDateTime(row.openedAt)}
              </TableCell>
              <TableCell>{t(CASE_TYPE_KEYS[row.type])}</TableCell>
              <TableCell numeric>
                <Money amount={row.differenceIdr} />
              </TableCell>
              <TableCell>{personLabel(row.ownerId)}</TableCell>
              <TableCell className="whitespace-nowrap tabular text-sm">
                {formatDateTime(row.dueAt)}
              </TableCell>
              <TableCell>
                <ReconciliationCaseStatusBadge status={row.status} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenCase(row.id)}
                >
                  {t("accounting.cash.recon.cases.open")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
