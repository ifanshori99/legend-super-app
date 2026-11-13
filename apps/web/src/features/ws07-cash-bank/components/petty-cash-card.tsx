// Petty cash (legend-4961; PRD v1.7 §3.19): one fund per outlet, topped up
// from and returned to a bank account. The balance never goes below zero (the
// API refuses it); purchases from the fund come from the simple-purchase
// screen with a photo, so this card has no "spend" action. A movement whose
// journal is parked (the petty cash account mapping is missing) says so in
// words and can be retried once the mapping is fixed.
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  RotateCw,
} from "lucide-react";
import * as React from "react";
import type { PettyCashFund } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
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
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  businessDateToday,
  formatBusinessDate,
  formatMonthLabel,
  monthRange,
  PETTY_KIND_KEYS,
} from "../lib";
import {
  usePettyCashEntries,
  usePettyCashFunds,
  usePostPettyCashEntry,
} from "../hooks";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import { PettyJournalBadge } from "./status-badges";

export type PettyMovementRequest = {
  kind: "topup" | "return";
  outletId: string | undefined;
};

export function PettyCashCard({
  legalEntityId,
  hasBankAccounts,
  accountsReady,
  onMove,
}: {
  legalEntityId: string;
  hasBankAccounts: boolean;
  /** False while the bank accounts load, so no "add a bank account" note yet. */
  accountsReady: boolean;
  onMove: (request: PettyMovementRequest) => void;
}) {
  const t = useT();
  const funds = usePettyCashFunds(legalEntityId);
  const outlets = useOutlets();
  const rows: readonly PettyCashFund[] = funds.data ?? [];
  const [historyOutletId, setHistoryOutletId] = React.useState<string | null>(
    null,
  );
  const historyOutlet =
    rows.find((fund) => fund.outletId === historyOutletId)?.outletId ??
    rows[0]?.outletId;
  // Never an id fragment: "—" while the lookup loads, a sentence on a miss.
  const outletName = (outletId: string) => {
    if (!outlets.isSuccess) return "—";
    return (
      outlets.data.find((outlet) => outlet.id === outletId)?.name ??
      t("accounting.cash.petty.outletMissing")
    );
  };
  const today = businessDateToday();
  const state: DataState = funds.isPending
    ? "loading"
    : funds.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";
  const topUp = hasBankAccounts ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => onMove({ kind: "topup", outletId: undefined })}
    >
      <ArrowDownToLine aria-hidden="true" />
      {t("accounting.cash.petty.topup")}
    </Button>
  ) : accountsReady ? (
    <p className="text-sm leading-5 text-muted-foreground">
      {t("accounting.cash.petty.noBankAccounts")}{" "}
      <a
        href="#bank-accounts"
        className="font-medium text-primary underline underline-offset-4"
      >
        {t("accounting.cash.petty.noBankAccountsLink")}
      </a>
    </p>
  ) : undefined;

  return (
    <div id="petty-cash" className="grid min-w-0 gap-5">
      <DataTableShell
        title={t("accounting.cash.petty.title")}
        description={`${t("accounting.cash.petty.subtitle")} ${t(
          "accounting.cash.petty.period",
          { month: formatMonthLabel(today) },
        )}`}
        state={state}
        error={funds.error}
        onRetry={() => {
          void funds.refetch();
        }}
        rowCount={rows.length}
        actions={state === "ready" ? topUp : undefined}
        empty={{
          title: t("accounting.cash.petty.emptyTitle"),
          description: t("accounting.cash.petty.emptyHint"),
          action: topUp,
        }}
      >
        <Table className="min-w-[40rem]">
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("accounting.cash.deposits.columns.outlet")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.cash.petty.balance")}
              </TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("accounting.cash.petty.columns.actions")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((fund) => (
              <TableRow key={fund.id}>
                <TableCell>
                  <Button
                    type="button"
                    variant={
                      fund.outletId === historyOutlet ? "secondary" : "ghost"
                    }
                    size="sm"
                    aria-pressed={fund.outletId === historyOutlet}
                    onClick={() => setHistoryOutletId(fund.outletId)}
                  >
                    {fund.outletId === historyOutlet ? (
                      <Check aria-hidden="true" />
                    ) : null}
                    {outletName(fund.outletId)}
                  </Button>
                </TableCell>
                <TableCell numeric>
                  <Money amount={fund.balanceIdr} />
                </TableCell>
                <TableCell>
                  {hasBankAccounts ? (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          onMove({ kind: "topup", outletId: fund.outletId })
                        }
                      >
                        <ArrowDownToLine aria-hidden="true" />
                        {t("accounting.cash.petty.topup")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={fund.balanceIdr <= 0}
                        onClick={() =>
                          onMove({ kind: "return", outletId: fund.outletId })
                        }
                      >
                        <ArrowUpFromLine aria-hidden="true" />
                        {t("accounting.cash.petty.return")}
                      </Button>
                      {fund.balanceIdr <= 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {t("accounting.cash.petty.returnNeedsBalance")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      {historyOutlet ? (
        <PettyCashHistory
          outletId={historyOutlet}
          outletLabel={outletName(historyOutlet)}
        />
      ) : null}
    </div>
  );
}

function PettyCashHistory({
  outletId,
  outletLabel,
}: {
  outletId: string;
  outletLabel: string;
}) {
  const t = useT();
  const toast = useToast();
  const today = businessDateToday();
  const range = monthRange(today);
  const entries = usePettyCashEntries(outletId, range.from, range.to);
  const retry = usePostPettyCashEntry();
  const rows = entries.data?.data ?? [];
  const state: DataState = entries.isPending
    ? "loading"
    : entries.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <DataTableShell
      title={t("accounting.cash.petty.history", { outlet: outletLabel })}
      description={t("accounting.cash.petty.period", {
        month: formatMonthLabel(today),
      })}
      state={state}
      error={entries.error}
      onRetry={() => {
        void entries.refetch();
      }}
      rowCount={rows.length}
      empty={{ title: t("accounting.cash.petty.historyEmpty") }}
    >
      <Table className="min-w-[48rem]">
        <TableHeader>
          <TableRow>
            <TableHead>{t("accounting.cash.petty.columns.date")}</TableHead>
            <TableHead>{t("accounting.cash.petty.columns.kind")}</TableHead>
            <TableHead>
              {t("accounting.cash.petty.columns.description")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.cash.petty.columns.amount")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.cash.petty.columns.balanceAfter")}
            </TableHead>
            <TableHead>{t("accounting.cash.petty.columns.journal")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="whitespace-nowrap tabular">
                {formatBusinessDate(entry.entryDate)}
              </TableCell>
              <TableCell className="text-sm">
                {t(PETTY_KIND_KEYS[entry.kind])}
              </TableCell>
              <TableCell className="text-sm">{entry.description}</TableCell>
              <TableCell numeric>
                <Money amount={entry.amountIdr} />
              </TableCell>
              <TableCell numeric>
                <Money amount={entry.balanceAfterIdr} />
              </TableCell>
              <TableCell>
                <div className="grid gap-1">
                  <PettyJournalBadge status={entry.journalStatus} />
                  {entry.journalStatus === "parked" ? (
                    <>
                      <p className="max-w-xs text-xs leading-4 text-muted-foreground">
                        {t("accounting.cash.petty.parkedHint")}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        loading={
                          retry.isPending && retry.variables === entry.id
                        }
                        disabled={retry.isPending}
                        onClick={() =>
                          retry.mutate(entry.id, {
                            onSuccess: () =>
                              toast({
                                title: t("accounting.cash.petty.retried"),
                                tone: "success",
                              }),
                            onError: (error) =>
                              toast({
                                title:
                                  error instanceof ApiError
                                    ? error.message
                                    : t("accounting.cash.petty.retryFailed"),
                                tone: "danger",
                              }),
                          })
                        }
                      >
                        <RotateCw aria-hidden="true" />
                        {t("accounting.cash.petty.retry")}
                      </Button>
                    </>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
