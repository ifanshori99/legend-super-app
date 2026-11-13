// Cash in, cash out and bank transfers (legend-4961; PRD v1.7 §3.19). One
// document per row, one journal per document. The write menu is one action;
// the list stays quiet. Shown only to people who hold
// accounting.cash_bank.record, because the endpoint answers 403 to everyone
// else.
import { ChevronDown, Plus } from "lucide-react";
import type {
  BankAccount,
  CashBankEntry,
  CashBankEntryKind,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Money } from "@/components/ui/money";
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
  formatMonthLabel,
  monthRange,
} from "../lib";
import { useCashBankEntries } from "../hooks";
import { useAccounts } from "@/features/ws07-accounting/hooks";
import { CashEntryKindBadge } from "./status-badges";

export function CashEntriesSection({
  legalEntityId,
  accounts,
  accountsReady,
  onAdd,
}: {
  legalEntityId: string;
  accounts: readonly BankAccount[];
  /** False while the bank accounts load: labels show "—", not a miss. */
  accountsReady: boolean;
  onAdd: (kind: CashBankEntryKind) => void;
}) {
  const t = useT();
  const today = businessDateToday();
  const range = monthRange(today);
  const entries = useCashBankEntries(legalEntityId, range.from, range.to);
  const glAccounts = useAccounts(legalEntityId);
  const rows = entries.data?.data ?? [];
  const state: DataState = entries.isPending
    ? "loading"
    : entries.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";
  const canAdd = accounts.length > 0;
  // Never an id fragment: "—" while the lookup loads, a sentence on a miss.
  const bankLabel = (bankAccountId: string) => {
    if (!accountsReady) return "—";
    const account = accounts.find((row) => row.id === bankAccountId);
    return account
      ? `${account.bank} · ${account.accountNumberMasked}`
      : t("accounting.cash.entries.bankMissing");
  };
  const counterLabel = (entry: CashBankEntry) => {
    if (entry.counterAccountId === null) return "—";
    if (!glAccounts.isSuccess) return "—";
    const account = glAccounts.data.find(
      (row) => row.id === entry.counterAccountId,
    );
    return account
      ? `${account.code} · ${account.name}`
      : t("accounting.cash.entries.accountMissing");
  };
  const accountCell = (entry: CashBankEntry) =>
    entry.kind === "transfer" && entry.toBankAccountId !== null
      ? t("accounting.cash.entries.transferArrow", {
          from: bankLabel(entry.bankAccountId),
          to: bankLabel(entry.toBankAccountId),
        })
      : bankLabel(entry.bankAccountId);

  const addMenu = canAdd ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus aria-hidden="true" />
          {t("accounting.cash.entries.add")}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAdd("cash_in")}>
          {t("accounting.cash.entries.addCashIn")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("cash_out")}>
          {t("accounting.cash.entries.addCashOut")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onAdd("transfer")}
          disabled={accounts.length < 2}
        >
          {t("accounting.cash.entries.addTransfer")}
          {accounts.length < 2 ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {t("accounting.cash.entries.transferNeedsTwo")}
            </span>
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : accountsReady ? (
    <p className="text-sm leading-5 text-muted-foreground">
      {t("accounting.cash.entries.noBankAccounts")}{" "}
      <a
        href="#bank-accounts"
        className="font-medium text-primary underline underline-offset-4"
      >
        {t("accounting.cash.entries.noBankAccountsLink")}
      </a>
    </p>
  ) : undefined;

  return (
    <div id="cash-entries" className="min-w-0">
      <DataTableShell
        title={t("accounting.cash.entries.title")}
        description={`${t("accounting.cash.entries.subtitle")} ${t(
          "accounting.cash.entries.period",
          { month: formatMonthLabel(today) },
        )}`}
        state={state}
        error={entries.error}
        onRetry={() => {
          void entries.refetch();
        }}
        rowCount={rows.length}
        actions={state === "ready" ? addMenu : undefined}
        empty={{
          title: t("accounting.cash.entries.emptyTitle"),
          description: t("accounting.cash.entries.emptyHint"),
          action: addMenu,
        }}
      >
        <Table className="min-w-[56rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("accounting.cash.entries.columns.date")}</TableHead>
              <TableHead>{t("accounting.cash.entries.columns.kind")}</TableHead>
              <TableHead>
                {t("accounting.cash.entries.columns.description")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.entries.columns.account")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.entries.columns.counter")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.cash.entries.columns.amount")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.entries.columns.reference")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap tabular">
                  {formatBusinessDate(entry.entryDate)}
                </TableCell>
                <TableCell>
                  <CashEntryKindBadge kind={entry.kind} />
                </TableCell>
                <TableCell className="text-sm">{entry.description}</TableCell>
                <TableCell className="text-sm">{accountCell(entry)}</TableCell>
                <TableCell className="text-sm">{counterLabel(entry)}</TableCell>
                <TableCell numeric>
                  <Money amount={entry.amountIdr} />
                </TableCell>
                <TableCell className="text-sm tabular">
                  {entry.reference ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
