// Cash deposits (ACC-05): the list of recorded outlet deposits and the warning
// band for cash still undeposited past the tenant's day limit. The band is a
// StatusBand — the warning is the band itself, in words, with the day count.
import { CircleCheck, Plus, TriangleAlert } from "lucide-react";
import type { BankAccount } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBand } from "@/components/ui/status-band";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  businessDateToday,
  formatBusinessDate,
  formatDateTime,
  monthRange,
  totalUndeposited,
} from "../lib";
import { useCashDeposits, useUndepositedAlerts } from "../hooks";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import { CashDepositStatusBadge } from "./status-badges";

export function DepositsSection({
  legalEntityId,
  accounts,
  canWrite,
  onAdd,
}: {
  legalEntityId: string;
  accounts: readonly BankAccount[];
  canWrite: boolean;
  onAdd: () => void;
}) {
  const t = useT();
  const today = businessDateToday();
  const range = monthRange(today);
  const deposits = useCashDeposits(legalEntityId, range.from, range.to);
  const alerts = useUndepositedAlerts(legalEntityId, today);
  const outlets = useOutlets();
  const outletName = (outletId: string) =>
    outlets.data?.data.find((outlet) => outlet.id === outletId)?.name ??
    outletId.slice(0, 8);
  const accountLabel = (bankAccountId: string) => {
    const account = accounts.find((row) => row.id === bankAccountId);
    return account
      ? `${account.bank} · ${account.accountNumberMasked}`
      : bankAccountId.slice(0, 8);
  };
  const rows = deposits.data?.data ?? [];
  const state: DataState = deposits.isPending
    ? "loading"
    : deposits.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <div id="cash-deposits" className="grid min-w-0 gap-5">
      {alerts.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : alerts.isError ? (
        <CardShell>
          <CardShellBody>
            <ErrorState
              onRetry={() => {
                void alerts.refetch();
              }}
            />
          </CardShellBody>
        </CardShell>
      ) : alerts.data.length > 0 ? (
        <section
          aria-label={t("accounting.cash.deposits.alerts.label")}
          className="overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline"
        >
          <StatusBand
            tone="warning"
            icon={TriangleAlert}
            label={t("accounting.cash.deposits.alerts.title")}
            aside={<Money amount={totalUndeposited(alerts.data)} />}
          >
            <p className="text-sm leading-5 font-semibold">
              {t("accounting.cash.deposits.alerts.description")}
            </p>
            <ul className="mt-1 grid gap-1">
              {alerts.data.map((alert) => (
                <li
                  key={`${alert.outletId}:${alert.businessDate}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm leading-5"
                >
                  <span>
                    {t("accounting.cash.deposits.alerts.line", {
                      outlet: outletName(alert.outletId),
                      date: formatBusinessDate(alert.businessDate),
                      days: alert.daysOutstanding,
                    })}
                  </span>
                  <Money amount={alert.undepositedIdr} size="sm" />
                </li>
              ))}
            </ul>
          </StatusBand>
        </section>
      ) : (
        <section
          aria-label={t("accounting.cash.deposits.alerts.label")}
          className="overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline"
        >
          <StatusBand
            tone="success"
            icon={CircleCheck}
            label={t("accounting.cash.deposits.alerts.emptyTitle")}
          >
            <p className="text-sm leading-5">
              {t("accounting.cash.deposits.alerts.emptyHint")}
            </p>
          </StatusBand>
        </section>
      )}

      <DataTableShell
        title={t("accounting.cash.deposits.title")}
        description={t("accounting.cash.deposits.subtitle")}
        state={state}
        onRetry={() => {
          void deposits.refetch();
        }}
        rowCount={rows.length}
        actions={
          canWrite && accounts.length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={onAdd}>
              <Plus aria-hidden="true" />
              {t("accounting.cash.deposits.add")}
            </Button>
          ) : undefined
        }
        empty={{
          title: t("accounting.cash.deposits.emptyTitle"),
          description: t("accounting.cash.deposits.emptyHint"),
          action:
            canWrite && accounts.length > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={onAdd}>
                <Plus aria-hidden="true" />
                {t("accounting.cash.deposits.add")}
              </Button>
            ) : undefined,
        }}
      >
        <Table className="min-w-[48rem]">
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("accounting.cash.deposits.columns.date")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.deposits.columns.outlet")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.deposits.columns.covers")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.cash.deposits.columns.amount")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.deposits.columns.bank")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.deposits.columns.slip")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.deposits.columns.status")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((deposit) => (
              <TableRow key={deposit.id}>
                <TableCell className="whitespace-nowrap tabular">
                  {formatDateTime(deposit.depositedAt)}
                </TableCell>
                <TableCell>{outletName(deposit.outletId)}</TableCell>
                <TableCell className="whitespace-nowrap tabular text-sm">
                  {t("accounting.cash.deposits.covers", {
                    from: formatBusinessDate(deposit.coversFrom),
                    to: formatBusinessDate(deposit.coversTo),
                  })}
                </TableCell>
                <TableCell numeric>
                  <Money amount={deposit.amountIdr} />
                </TableCell>
                <TableCell className="text-sm">
                  {accountLabel(deposit.bankAccountId)}
                </TableCell>
                <TableCell className="text-sm tabular">
                  {deposit.slipReference ?? "—"}
                </TableCell>
                <TableCell>
                  <CashDepositStatusBadge status={deposit.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
