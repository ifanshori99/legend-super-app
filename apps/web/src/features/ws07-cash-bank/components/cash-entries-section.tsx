// Cash in, cash out and bank transfers (legend-4961; PRD v1.7 §3.19). One
// document per row, one journal per document. The write menu is one action;
// the list stays quiet. Shown only to people who hold
// accounting.cash_bank.record, because the endpoint answers 403 to everyone
// else. A cash out above the tenant limit waits for a second person (Q7): the
// row says so, and Setujui/Tolak show only to someone who holds
// accounting.cash_bank.approve and did not create the entry.
import * as React from "react";
import { ChevronDown, Plus } from "lucide-react";
import type {
  BankAccount,
  CashBankEntry,
  CreatableCashBankEntryKind,
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
import { useApproveCashBankEntry, useCashBankEntries } from "../hooks";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useAccounts } from "@/features/ws07-accounting/hooks";
import { useCurrentAuth } from "@/features/ws01-approvals/hooks";
import { useCanApproveCashBank, useCanManageCashApprovalLimit } from "../guard";
import { moneyErrorKey } from "../lib";
import { CashApprovalLimitCard } from "./cash-approval-limit-card";
import { CashEntryRejectDialog } from "./cash-entry-reject-dialog";
import { CashEntryKindBadge, CashEntryStatusBadge } from "./status-badges";

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
  onAdd: (kind: CreatableCashBankEntryKind) => void;
}) {
  const t = useT();
  const toast = useToast();
  const canApprove = useCanApproveCashBank();
  const canManageLimit = useCanManageCashApprovalLimit();
  const userId = useCurrentAuth().data?.data.user.id ?? null;
  const approve = useApproveCashBankEntry();
  const [rejectId, setRejectId] = React.useState<string | null>(null);
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
  // Fail closed: without a known user the buttons stay hidden (the API also
  // refuses the creator, CASH_OUT_SELF_APPROVAL).
  const canDecide = (entry: CashBankEntry) =>
    canApprove &&
    entry.status === "pending_approval" &&
    userId !== null &&
    entry.createdBy !== userId;
  const approveEntry = (entryId: string) =>
    approve.mutate(entryId, {
      onSuccess: () =>
        toast({
          title: t("accounting.cash.entries.approval.approved"),
          tone: "success",
        }),
      onError: (error) => {
        const key =
          error instanceof ApiError ? moneyErrorKey(error.code) : null;
        toast({
          title: key
            ? t(key)
            : error instanceof ApiError
              ? error.message
              : t("accounting.cash.entries.approval.failed"),
          tone: "danger",
        });
      },
    });
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
    <div id="cash-entries" className="grid min-w-0 gap-5">
      {canManageLimit ? <CashApprovalLimitCard /> : null}
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
        <Table className="min-w-[64rem]">
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
              <TableHead>
                {t("accounting.cash.entries.columns.status")}
              </TableHead>
              {canApprove ? (
                <TableHead>
                  {t("accounting.cash.entries.columns.actions")}
                </TableHead>
              ) : null}
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
                <TableCell className="text-sm">
                  <CashEntryStatusBadge status={entry.status} />
                  {entry.status === "rejected" &&
                  entry.decisionReason !== null ? (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t("accounting.cash.entries.approval.decisionReason", {
                        reason: entry.decisionReason,
                      })}
                    </p>
                  ) : null}
                </TableCell>
                {canApprove ? (
                  <TableCell>
                    {canDecide(entry) ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          loading={
                            approve.isPending && approve.variables === entry.id
                          }
                          disabled={approve.isPending}
                          onClick={() => approveEntry(entry.id)}
                        >
                          {t("accounting.cash.entries.approval.approve")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={approve.isPending}
                          onClick={() => setRejectId(entry.id)}
                        >
                          {t("accounting.cash.entries.approval.reject")}
                        </Button>
                      </div>
                    ) : entry.status === "pending_approval" &&
                      userId !== null &&
                      entry.createdBy === userId ? (
                      <span className="text-xs leading-5 text-muted-foreground">
                        {t("accounting.cash.entries.approval.ownEntry")}
                      </span>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      <CashEntryRejectDialog
        entryId={rejectId}
        onClose={() => setRejectId(null)}
      />
    </div>
  );
}
