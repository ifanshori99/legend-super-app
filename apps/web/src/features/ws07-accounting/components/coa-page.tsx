// Chart of accounts per legal entity (PRD v1.7 §3.19 "Chart of Accounts [P0]
// — CoA standar F&B yang dapat disesuaikan, per badan usaha"). The table is the
// tree: header accounts group, leaf accounts take journal lines. Codes and
// amounts are tabular so a controller can scan columns.
import * as React from "react";
import { FolderTree, Pencil, Plus } from "lucide-react";
import type { Account } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAccounts } from "../hooks";
import {
  ACCOUNT_TYPE_KEYS,
  REPORT_GROUP_KEYS,
  accountTreeRows,
  matchesAccount,
} from "../lib";
import { AccountFormDialog } from "./account-form-dialog";
import { AccountStatusBadge } from "./status-badge";

export function ChartOfAccountsPage({
  legalEntityId,
}: {
  legalEntityId: string;
}) {
  const t = useT();
  const accountsQuery = useAccounts(legalEntityId);
  const [search, setSearch] = React.useState("");
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Account | null>(null);

  const accounts = React.useMemo(
    () => accountsQuery.data ?? [],
    [accountsQuery.data],
  );
  const rows = React.useMemo(() => accountTreeRows(accounts), [accounts]);
  const visible = rows.filter(({ account }) => matchesAccount(account, search));
  const state: DataState = accountsQuery.isPending
    ? "loading"
    : accountsQuery.isError
      ? "error"
      : accounts.length === 0
        ? "empty"
        : "ready";

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (account: Account) => {
    setEditing(account);
    setFormOpen(true);
  };

  return (
    <>
      <DataTableShell
        title={t("accounting.coa.title")}
        description={t("accounting.coa.subtitle")}
        state={state}
        onRetry={() => {
          void accountsQuery.refetch();
        }}
        search={{
          value: search,
          onChange: setSearch,
          label: t("accounting.coa.search"),
        }}
        noResults={search.trim() !== "" && visible.length === 0}
        rowCount={accounts.length}
        actions={
          state === "empty" ? undefined : (
            <Button type="button" onClick={openCreate} size="sm">
              <Plus aria-hidden="true" />
              {t("accounting.coa.add")}
            </Button>
          )
        }
        empty={{
          title: t("accounting.coa.emptyTitle"),
          description: t("accounting.coa.emptyHint"),
          action: (
            <Button type="button" onClick={openCreate} size="sm">
              <Plus aria-hidden="true" />
              {t("accounting.coa.add")}
            </Button>
          ),
        }}
      >
        {/* Phones: one row per account, everything a controller needs. */}
        <ul className="divide-y divide-border md:hidden">
          {visible.map(({ account, depth, isHeader }) => (
            <li
              key={account.id}
              className="flex items-start justify-between gap-2 p-card"
            >
              <div
                className="grid min-w-0 gap-1"
                style={{ paddingInlineStart: `${depth * 12}px` }}
              >
                <span className="flex min-w-0 items-center gap-1.5 font-medium">
                  <span className="tabular text-muted-foreground">
                    {account.code}
                  </span>
                  <span className="truncate">{account.name}</span>
                  {isHeader && (
                    <FolderTree
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(ACCOUNT_TYPE_KEYS[account.type])} ·{" "}
                  {t(REPORT_GROUP_KEYS[account.reportGroup])}
                </span>
                <AccountStatusBadge active={account.isActive} />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("accounting.coa.edit")} ${account.code} ${account.name}`}
                onClick={() => openEdit(account)}
              >
                <Pencil aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[40rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounting.coa.columns.code")}</TableHead>
                <TableHead>{t("accounting.coa.columns.name")}</TableHead>
                <TableHead>{t("accounting.coa.columns.type")}</TableHead>
                <TableHead>{t("accounting.coa.columns.group")}</TableHead>
                <TableHead>{t("accounting.coa.columns.status")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("accounting.coa.edit")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ account, depth, isHeader }) => (
                <TableRow key={account.id}>
                  <TableCell className="tabular text-muted-foreground">
                    {account.code}
                  </TableCell>
                  <TableCell>
                    <span
                      className="flex min-w-0 items-center gap-1.5"
                      style={{ paddingInlineStart: `${depth * 16}px` }}
                    >
                      {isHeader && (
                        <FolderTree
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{account.name}</span>
                      {isHeader && (
                        <span className="sr-only">
                          {t("accounting.coa.header")}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>{t(ACCOUNT_TYPE_KEYS[account.type])}</TableCell>
                  <TableCell>
                    {t(REPORT_GROUP_KEYS[account.reportGroup])}
                  </TableCell>
                  <TableCell>
                    <AccountStatusBadge active={account.isActive} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t("accounting.coa.edit")} ${account.code} ${account.name}`}
                      onClick={() => openEdit(account)}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>
      <AccountFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        legalEntityId={legalEntityId}
        accounts={accounts}
        account={editing}
      />
    </>
  );
}
