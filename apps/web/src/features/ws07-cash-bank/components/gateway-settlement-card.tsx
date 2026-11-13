// Gateway settlement vs the bank (PRD §3.19 "Rekonsiliasi Gateway [P0]":
// "Pencocokan settlement DOIT terhadap transaksi dan mutasi bank, termasuk
// biaya MDR QRIS dan biaya layanan Virtual Account"). Each settlement journal
// renders its bruto, every fee as its own row (so MDR QRIS and a VA service
// fee never collapse into one number) and the net that must appear in the
// bank statement. A settlement without a matched line becomes a case with PIC.
import * as React from "react";
import { FolderOpen } from "lucide-react";
import type { Account, BankAccount } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountById, accountLabel } from "@/features/ws07-accounting/lib";
import { formatBusinessDate } from "../lib";
import { useGatewaySettlementRecon } from "../hooks";
import { OpenCaseDialog } from "./open-case-dialog";

type SettlementRow = NonNullable<
  ReturnType<typeof useGatewaySettlementRecon>["data"]
>["rows"][number];

export function GatewaySettlementCard({
  legalEntityId,
  account,
  glAccounts,
  from,
  to,
  canWrite,
}: {
  legalEntityId: string;
  account: BankAccount | undefined;
  glAccounts: readonly Account[];
  from: string;
  to: string;
  canWrite: boolean;
}) {
  const t = useT();
  const recon = useGatewaySettlementRecon(legalEntityId, account?.id, from, to);
  const [caseRow, setCaseRow] = React.useState<SettlementRow | null>(null);
  const rows = React.useMemo(() => recon.data?.rows ?? [], [recon.data]);
  const byId = accountById(glAccounts);
  const state: DataState = !account
    ? "empty"
    : recon.isPending
      ? "loading"
      : recon.isError
        ? "error"
        : rows.length === 0
          ? "empty"
          : "ready";

  const feeLabel = (accountId: string) => {
    const gl = byId.get(accountId);
    return gl ? accountLabel(gl) : accountId.slice(0, 8);
  };

  return (
    <>
      <DataTableShell
        title={t("accounting.cash.recon.settlement.title")}
        description={t("accounting.cash.recon.settlement.subtitle")}
        state={state}
        onRetry={() => {
          void recon.refetch();
        }}
        rowCount={rows.length}
        empty={{
          title: t("accounting.cash.recon.settlement.emptyTitle"),
          description: t("accounting.cash.recon.settlement.emptyHint"),
        }}
      >
        <Table className="min-w-[52rem]">
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("accounting.cash.recon.settlement.columns.date")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.recon.settlement.columns.description")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.cash.recon.settlement.columns.gross")}
              </TableHead>
              <TableHead>
                {t("accounting.cash.recon.settlement.columns.fee")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.cash.recon.settlement.columns.net")}
              </TableHead>
              <TableHead className="text-right">
                {t("accounting.cash.recon.settlement.columns.status")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.journalId}>
                <TableCell className="whitespace-nowrap tabular">
                  {formatBusinessDate(row.entryDate)}
                </TableCell>
                <TableCell className="max-w-72">
                  <span className="block truncate font-medium">
                    {row.description}
                  </span>
                  <span className="block text-sm tabular text-muted-foreground">
                    {row.settlementId.slice(0, 8)}
                  </span>
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.grossIdr} />
                </TableCell>
                <TableCell>
                  {row.fees.length === 0 ? (
                    <span className="text-sm text-muted-foreground">—</span>
                  ) : (
                    <ul className="grid gap-1">
                      {row.fees.map((fee) => (
                        <li
                          key={`${row.journalId}:${fee.accountId}`}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="text-sm text-muted-foreground">
                            {t("accounting.cash.recon.settlement.feeLine", {
                              account: feeLabel(fee.accountId),
                            })}
                          </span>
                          <Money amount={fee.amountIdr} size="sm" />
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.netIdr} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="grid justify-items-end gap-1">
                    {row.statementLineId ? (
                      <Badge tone="success">
                        {t("accounting.cash.recon.settlement.status")}
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        {t("accounting.cash.recon.settlement.unmatched")}
                      </Badge>
                    )}
                    {row.varianceIdr !== 0 && (
                      <span className="flex items-center gap-1 text-sm">
                        {t("accounting.cash.recon.settlement.variance")}
                        <Money amount={row.varianceIdr} size="sm" />
                      </span>
                    )}
                    {canWrite &&
                      (!row.statementLineId || row.varianceIdr !== 0) &&
                      row.netIdr !== 0 && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setCaseRow(row)}
                        >
                          <FolderOpen aria-hidden="true" />
                          {t("accounting.cash.recon.settlement.openCase")}
                        </Button>
                      )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      {account && caseRow && (
        <OpenCaseDialog
          open={caseRow !== null}
          onOpenChange={(open) => {
            if (!open) setCaseRow(null);
          }}
          legalEntityId={legalEntityId}
          type="gateway_settlement"
          differenceIdr={
            caseRow.varianceIdr !== 0 ? caseRow.varianceIdr : caseRow.netIdr
          }
          refs={[
            { type: "gateway_settlement", id: caseRow.settlementId },
            ...(caseRow.statementLineId
              ? [
                  {
                    type: "bank_statement_line" as const,
                    id: caseRow.statementLineId,
                  },
                ]
              : []),
          ]}
          description={caseRow.description}
        />
      )}
    </>
  );
}
