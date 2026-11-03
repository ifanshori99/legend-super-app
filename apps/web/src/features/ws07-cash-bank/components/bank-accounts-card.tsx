// Bank accounts of one legal entity: the list the match workspace, the import
// wizard and the deposit form choose from. Amounts are not shown here: the
// contract exposes no account balance (see the bead report), so the columns
// stay to what bankAccountSchema actually carries.
import { CircleCheck, CircleSlash, Plus } from "lucide-react";
import type { Account, BankAccount } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
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
import { accountById, accountLabel } from "@/features/ws07-accounting/lib";

export function BankAccountsCard({
  accounts,
  glAccounts,
  state,
  onRetry,
  canWrite,
  selectedId,
  onSelect,
  onAdd,
}: {
  accounts: readonly BankAccount[];
  glAccounts: readonly Account[];
  state: DataState;
  onRetry: () => void;
  canWrite: boolean;
  selectedId: string | null;
  onSelect: (bankAccountId: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const byId = accountById(glAccounts);
  return (
    <DataTableShell
      title={t("accounting.cash.accounts.title")}
      description={t("accounting.cash.accounts.subtitle")}
      state={state}
      onRetry={onRetry}
      rowCount={accounts.length}
      actions={
        canWrite && state !== "empty" ? (
          // Outline: the screen's one filled action is "Impor mutasi".
          <Button type="button" variant="outline" size="sm" onClick={onAdd}>
            <Plus aria-hidden="true" />
            {t("accounting.cash.accounts.add")}
          </Button>
        ) : undefined
      }
      empty={{
        title: t("accounting.cash.accounts.emptyTitle"),
        description: t("accounting.cash.accounts.emptyHint"),
        action: canWrite ? (
          <Button type="button" size="sm" onClick={onAdd}>
            <Plus aria-hidden="true" />
            {t("accounting.cash.accounts.add")}
          </Button>
        ) : undefined,
      }}
    >
      <Table className="min-w-[40rem]">
        <TableHeader>
          <TableRow>
            <TableHead>{t("accounting.cash.accounts.columns.bank")}</TableHead>
            <TableHead>{t("accounting.cash.accounts.columns.name")}</TableHead>
            <TableHead>
              {t("accounting.cash.accounts.columns.number")}
            </TableHead>
            <TableHead>{t("accounting.cash.accounts.columns.gl")}</TableHead>
            <TableHead>
              {t("accounting.cash.accounts.columns.status")}
            </TableHead>
            <TableHead className="text-right">
              {t("accounting.cash.accounts.columns.action")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => {
            const glAccount = byId.get(account.glAccountId);
            const selected = account.id === selectedId;
            return (
              <TableRow key={account.id}>
                <TableCell className="font-medium">{account.bank}</TableCell>
                <TableCell>{account.accountName}</TableCell>
                <TableCell className="tabular">
                  {account.accountNumberMasked}
                </TableCell>
                <TableCell>
                  {glAccount ? accountLabel(glAccount) : account.glAccountId}
                </TableCell>
                <TableCell>
                  {account.isActive ? (
                    <Badge tone="success">
                      <CircleCheck aria-hidden="true" />
                      {t("accounting.cash.accounts.active")}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      <CircleSlash aria-hidden="true" />
                      {t("accounting.cash.accounts.inactive")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {selected ? (
                    <Badge tone="info">
                      {t("accounting.cash.accounts.selected")}
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onSelect(account.id)}
                    >
                      {t("accounting.cash.accounts.select")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
