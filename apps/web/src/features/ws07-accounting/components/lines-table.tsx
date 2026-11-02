// Read-only journal lines with the per-line account, outlet and cost center,
// the totals, and the ACC-01 balance verdict. Used by the journal detail and
// by the recurring template preview. Phones get one card per line (debit and
// credit labelled); from md up the table shows the columns side by side.
import { CircleAlert, CircleCheck } from "lucide-react";
import type { Account } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { entryBalance } from "../lib";

export type DisplayLine = {
  accountId: string;
  outletId: string | null;
  costCenter: string | null;
  debitIdr: number;
  creditIdr: number;
};

export function JournalLinesTable({
  lines,
  accounts,
  outlets,
}: {
  lines: readonly DisplayLine[];
  accounts: ReadonlyMap<string, Account>;
  outlets: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const balance = entryBalance(lines);
  const empty = t("accounting.journal.empty");
  const outletOf = (line: DisplayLine) =>
    line.outletId
      ? (outlets.get(line.outletId) ?? line.outletId)
      : t("accounting.journal.outletNone");

  return (
    <div className="grid min-w-0">
      <ul className="divide-y divide-border md:hidden">
        {lines.map((line, index) => {
          const account = accounts.get(line.accountId);
          return (
            <li
              key={`${line.accountId}-${index}`}
              className="grid gap-2 p-card"
            >
              <div className="grid gap-0.5">
                <span className="font-medium">
                  <span className="tabular text-muted-foreground">
                    {account?.code ?? empty}
                  </span>{" "}
                  {account?.name ?? line.accountId}
                </span>
                <span className="text-sm text-muted-foreground">
                  {outletOf(line)}
                  {line.costCenter ? ` · ${line.costCenter}` : ""}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div className="grid gap-0.5">
                  <dt className="text-muted-foreground">
                    {t("accounting.journal.columns.debit")}
                  </dt>
                  <dd>
                    {line.debitIdr > 0 ? (
                      <Money amount={line.debitIdr} size="sm" />
                    ) : (
                      empty
                    )}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted-foreground">
                    {t("accounting.journal.columns.credit")}
                  </dt>
                  <dd>
                    {line.creditIdr > 0 ? (
                      <Money amount={line.creditIdr} size="sm" />
                    ) : (
                      empty
                    )}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("accounting.journal.columns.account")}</TableHead>
              <TableHead>{t("accounting.journal.columns.outlet")}</TableHead>
              <TableHead className="hidden lg:table-cell">
                {t("accounting.journal.columns.costCenter")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.journal.columns.debit")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.journal.columns.credit")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => {
              const account = accounts.get(line.accountId);
              return (
                <TableRow key={`${line.accountId}-${index}`}>
                  <TableCell>
                    <span className="tabular text-muted-foreground">
                      {account?.code ?? empty}
                    </span>{" "}
                    <span>{account?.name ?? line.accountId}</span>
                  </TableCell>
                  <TableCell>{outletOf(line)}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {line.costCenter ?? empty}
                  </TableCell>
                  <TableCell numeric>
                    {line.debitIdr > 0 ? (
                      <Money amount={line.debitIdr} />
                    ) : (
                      <span className="text-muted-foreground">{empty}</span>
                    )}
                  </TableCell>
                  <TableCell numeric>
                    {line.creditIdr > 0 ? (
                      <Money amount={line.creditIdr} />
                    ) : (
                      <span className="text-muted-foreground">{empty}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border p-card">
        {balance.balanced ? (
          <Badge tone="success">
            <CircleCheck aria-hidden="true" />
            {t("accounting.journal.balanced")}
          </Badge>
        ) : (
          <Badge tone="danger">
            <CircleAlert aria-hidden="true" />
            {t("accounting.journal.unbalanced")}
          </Badge>
        )}
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.journal.total")}{" "}
              {t("accounting.journal.columns.debit").toLocaleLowerCase("id-ID")}
            </dt>
            <dd>
              <Money amount={balance.debitIdr} size="sm" />
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.journal.total")}{" "}
              {t("accounting.journal.columns.credit").toLocaleLowerCase(
                "id-ID",
              )}
            </dt>
            <dd>
              <Money amount={balance.creditIdr} size="sm" />
            </dd>
          </div>
        </dl>
      </div>
      <p className="px-card pb-card text-sm leading-5 text-muted-foreground">
        {t("accounting.journal.balanceHint")}
      </p>
    </div>
  );
}
