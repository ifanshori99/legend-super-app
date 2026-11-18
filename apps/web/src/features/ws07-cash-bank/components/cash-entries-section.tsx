// Cash in, cash out and bank transfers (legend-4961; PRD v1.7 §3.19). One
// document per row, one journal per document. The write menu is one action;
// the list stays quiet. Shown only to people who hold
// accounting.cash_bank.record, because the endpoint answers 403 to everyone
// else. A cash out above the tenant limit waits for a second person (Q7): the
// row says so. Approving goes through the approval inbox (legend-fukt6): a
// pending cash out always has a chain, and the direct approve answers
// CASH_OUT_CHAIN_OPEN/MISSING until every level approved, so the row links to
// the inbox instead of offering a direct Setujui. Tolak (reject) stays here and
// shows only to someone who holds accounting.cash_bank.approve and did not
// create the entry.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Plus } from "lucide-react";
import type {
  BankAccount,
  CashBankEntry,
  CreatableCashBankEntryKind,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { cn } from "cn";
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
  CASH_ENTRY_KIND_KEYS,
  businessDateToday,
  formatBusinessDate,
  formatMonthLabel,
  monthRange,
} from "../lib";
import { useCashBankEntries } from "../hooks";
import { useAccounts } from "@/features/ws07-accounting/hooks";
import { useCurrentAuth } from "@/features/ws01-approvals/hooks";
import { useSupportReadOnly } from "@/features/ws01-support-access/read-only";
import {
  useCanApproveCashBank,
  useCanManageCashApprovalLimit,
  useCanViewApprovalInbox,
} from "../guard";
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
  const canApprove = useCanApproveCashBank();
  const supportReadOnly = useSupportReadOnly();
  const canViewInbox = useCanViewApprovalInbox();
  const canManageLimit = useCanManageCashApprovalLimit();
  const userId = useCurrentAuth().data?.data.user.id ?? null;
  const [rejectTarget, setRejectTarget] = React.useState<CashBankEntry | null>(
    null,
  );
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
  // Inbox link + Tolak for someone else's pending entry; the hint for your own.
  // Table and card share it, so both honor canDecide.
  const decisionControls = (
    entry: CashBankEntry,
    size: "sm" | "default" = "sm",
  ) => {
    if (!canApprove) return null;
    if (canDecide(entry)) {
      return (
        <div className="flex flex-wrap gap-2">
          {canViewInbox ? (
            <Button
              asChild
              size={size}
              className={cn(
                "whitespace-normal",
                size === "default" && "min-h-11",
              )}
            >
              <Link
                to="/kelola/persetujuan"
                aria-label={t("accounting.cash.entries.approval.inboxLabel", {
                  description: entry.description,
                })}
              >
                {t("accounting.cash.entries.approval.inbox")}
              </Link>
            </Button>
          ) : null}
          <Button
            type="button"
            size={size}
            className={size === "default" ? "min-h-11" : undefined}
            variant="outline"
            aria-label={t("accounting.cash.entries.approval.actionLabel", {
              action: t("accounting.cash.entries.approval.reject"),
              description: entry.description,
            })}
            disabled={supportReadOnly}
            onClick={() => setRejectTarget(entry)}
          >
            {t("accounting.cash.entries.approval.reject")}
          </Button>
        </div>
      );
    }
    if (
      entry.status === "pending_approval" &&
      userId !== null &&
      entry.createdBy === userId
    ) {
      return (
        <span className="text-xs leading-5 text-muted-foreground">
          {t("accounting.cash.entries.approval.ownEntry", {
            kind: t(CASH_ENTRY_KIND_KEYS[entry.kind]).toLocaleLowerCase("id"),
          })}
        </span>
      );
    }
    return null;
  };
  const decisionReason = (entry: CashBankEntry) =>
    entry.status === "rejected" && entry.decisionReason !== null ? (
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {t("accounting.cash.entries.approval.decisionReason", {
          reason: entry.decisionReason,
        })}
      </p>
    ) : null;
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
        <div className="@container">
          <div className="hidden @[58rem]:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-2">
                    {t("accounting.cash.entries.columns.kindDate")}
                  </TableHead>
                  <TableHead className="px-2">
                    {t("accounting.cash.entries.columns.description")}
                  </TableHead>
                  <TableHead className="px-2">
                    {t("accounting.cash.entries.columns.account")}
                  </TableHead>
                  <TableHead numeric className="px-2">
                    {t("accounting.cash.entries.columns.amount")}
                  </TableHead>
                  <TableHead className="px-2">
                    {t("accounting.cash.entries.columns.status")}
                  </TableHead>
                  {canApprove ? (
                    <TableHead className="px-2">
                      {t("accounting.cash.entries.columns.actions")}
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="px-2">
                      <CashEntryKindBadge kind={entry.kind} />
                      <p className="mt-0.5 text-xs whitespace-nowrap tabular text-muted-foreground">
                        {formatBusinessDate(entry.entryDate)}
                      </p>
                    </TableCell>
                    <TableCell className="px-2 text-sm">
                      <p
                        className="line-clamp-2 max-w-[9.5rem]"
                        title={entry.description}
                      >
                        {entry.description}
                      </p>
                      {entry.reference !== null ? (
                        <p className="mt-0.5 max-w-[9.5rem] truncate text-xs tabular text-muted-foreground">
                          {entry.reference}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="px-2 text-sm">
                      {entry.kind === "transfer" &&
                      entry.toBankAccountId !== null ? (
                        <>
                          <p className="max-w-[9.5rem] break-words">
                            {t("accounting.cash.entries.transferFrom", {
                              account: bankLabel(entry.bankAccountId),
                            })}
                          </p>
                          <p className="max-w-[9.5rem] break-words">
                            {t("accounting.cash.entries.transferTo", {
                              account: bankLabel(entry.toBankAccountId),
                            })}
                          </p>
                        </>
                      ) : (
                        <p
                          className="max-w-[9.5rem] truncate"
                          title={accountCell(entry)}
                        >
                          {accountCell(entry)}
                        </p>
                      )}
                      {entry.counterAccountId !== null ? (
                        <p
                          className="mt-0.5 max-w-[9.5rem] truncate text-xs text-muted-foreground"
                          title={counterLabel(entry)}
                        >
                          {counterLabel(entry)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell numeric className="px-2">
                      <Money amount={entry.amountIdr} />
                    </TableCell>
                    <TableCell className="px-2 text-sm">
                      <CashEntryStatusBadge status={entry.status} />
                      {decisionReason(entry)}
                    </TableCell>
                    {canApprove ? (
                      <TableCell className="px-2">
                        {decisionControls(entry)}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="grid gap-3 p-card @[58rem]:hidden">
            {rows.map((entry) => {
              const controls = decisionControls(entry, "default");
              return (
                <li
                  key={entry.id}
                  className="grid gap-2 rounded-lg border bg-card p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <CashEntryKindBadge kind={entry.kind} />
                    <Money amount={entry.amountIdr} />
                  </div>
                  <p className="text-sm break-words">{entry.description}</p>
                  <dl className="grid gap-1 text-sm text-muted-foreground">
                    <div className="flex justify-between gap-3">
                      <dt>{t("accounting.cash.entries.columns.date")}</dt>
                      <dd className="tabular">
                        {formatBusinessDate(entry.entryDate)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>{t("accounting.cash.entries.columns.account")}</dt>
                      <dd className="min-w-0 text-right break-words">
                        {accountCell(entry)}
                      </dd>
                    </div>
                    {entry.counterAccountId !== null ? (
                      <div className="flex justify-between gap-3">
                        <dt>{t("accounting.cash.entries.columns.counter")}</dt>
                        <dd className="min-w-0 text-right break-words">
                          {counterLabel(entry)}
                        </dd>
                      </div>
                    ) : null}
                    {entry.reference !== null ? (
                      <div className="flex justify-between gap-3">
                        <dt>
                          {t("accounting.cash.entries.columns.reference")}
                        </dt>
                        <dd className="tabular">{entry.reference}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <div>
                    <CashEntryStatusBadge status={entry.status} />
                    {decisionReason(entry)}
                  </div>
                  {controls !== null ? <div>{controls}</div> : null}
                </li>
              );
            })}
          </ul>
        </div>
      </DataTableShell>
      <CashEntryRejectDialog
        entry={rejectTarget}
        onClose={() => setRejectTarget(null)}
      />
    </div>
  );
}
