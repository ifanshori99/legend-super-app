// Anggaran (PRD v1.7 §3.19 "Anggaran [P0] — Anggaran per akun dan outlet
// dengan laporan realisasi"). The period and outlet scope both the budget and
// the posted actuals; variance comes from the contract helper, never from a
// client-side accounting rule.
import * as React from "react";
import { Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  businessDateToday,
  formatPeriod,
} from "@/features/ws07-accounting/lib";
import { useAccountingOutlets, useBudgetVsActual } from "../hooks";
import { budgetTotals, formatVarianceBp } from "../lib";
import { BudgetDialog } from "./budget-dialog";
import { BudgetVarianceBadge } from "./status-badge";

export function BudgetsPage({ legalEntityId }: { legalEntityId: string }) {
  const t = useT();
  const outletsQuery = useAccountingOutlets();
  const outlets = React.useMemo(
    () => outletsQuery.data ?? [],
    [outletsQuery.data],
  );
  const [period, setPeriod] = React.useState(() =>
    businessDateToday().slice(0, 7),
  );
  const [outletChoice, setOutletChoice] = React.useState<string | null>(null);
  const activeOutlet =
    outlets.find((outlet) => outlet.id === outletChoice) ?? outlets[0];
  const outletId = activeOutlet?.id;
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const outletFieldId = React.useId();

  const reportQuery = useBudgetVsActual({
    legalEntityId,
    period,
    outletId,
  });
  const rows = React.useMemo(() => reportQuery.data ?? [], [reportQuery.data]);
  const totals = React.useMemo(() => budgetTotals(rows), [rows]);

  const state: DataState = reportQuery.isPending
    ? "loading"
    : reportQuery.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";
  const outletName =
    activeOutlet?.name ?? t("accounting.ap.assets.form.outletNone");
  const context = t("accounting.ap.budgets.stats.context", {
    period: formatPeriod(period),
    outlet: outletName,
  });
  const variancePercent =
    formatVarianceBp(totals.varianceBp) ??
    t("accounting.ap.budgets.variance.noBudget");

  return (
    <div className="grid min-w-0 gap-5">
      <section
        aria-label={t("accounting.ap.budgets.title")}
        className="grid gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline sm:grid-cols-2 lg:grid-cols-4"
      >
        <FormField label={t("accounting.ap.budgets.period")} required>
          <Input
            type="month"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            className="tabular"
          />
        </FormField>
        <FormField id={outletFieldId} label={t("accounting.ap.budgets.outlet")}>
          <Select
            value={activeOutlet?.id ?? "none"}
            disabled={outlets.length === 0}
            onValueChange={setOutletChoice}
          >
            <SelectTrigger id={outletFieldId} className="h-control-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {outlets.length === 0 && (
                <SelectItem value="none">
                  {t("accounting.ap.assets.form.outletNone")}
                </SelectItem>
              )}
              {outlets.map((outlet) => (
                <SelectItem key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </section>

      {reportQuery.isPending ? (
        <div
          className="grid gap-2 rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline sm:grid-cols-2 lg:grid-cols-4"
          aria-busy="true"
        >
          <span className="sr-only">{t("common.loading")}</span>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : reportQuery.data ? (
        <StatStrip label={t("accounting.ap.budgets.title")} columns={4}>
          <StatTile
            label={t("accounting.ap.budgets.stats.budget")}
            value={<Money amount={totals.budgetIdr} size="stat" />}
            context={context}
          />
          <StatTile
            label={t("accounting.ap.budgets.stats.actual")}
            value={<Money amount={totals.actualIdr} size="stat" />}
            context={context}
          />
          <StatTile
            label={t("accounting.ap.budgets.stats.variance")}
            value={<Money amount={totals.varianceIdr} size="stat" />}
            context={variancePercent}
          />
          <StatTile
            label={t("accounting.ap.budgets.stats.accounts")}
            value={<NumberDisplay value={rows.length} size="stat" />}
            context={context}
          />
        </StatStrip>
      ) : null}

      <DataTableShell
        title={t("accounting.ap.budgets.title")}
        description={context}
        state={state}
        onRetry={() => {
          void reportQuery.refetch();
        }}
        actions={
          state === "empty" ? undefined : (
            <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden="true" />
              {t("accounting.ap.budgets.set")}
            </Button>
          )
        }
        rowCount={rows.length}
        loadingRows={4}
        empty={{
          title: t("accounting.ap.budgets.emptyTitle"),
          description: t("accounting.ap.budgets.emptyHint"),
          action: (
            <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden="true" />
              {t("accounting.ap.budgets.emptyAction")}
            </Button>
          ),
        }}
      >
        <ul className="divide-y divide-border md:hidden">
          {rows.map((row) => (
            <li key={row.accountId} className="grid gap-2 p-card">
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate font-medium">
                    {row.accountCode} · {row.accountName}
                  </span>
                  <BudgetVarianceBadge varianceIdr={row.varianceIdr} />
                </div>
                <Money amount={row.varianceIdr} />
              </div>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">
                    {t("accounting.ap.budgets.columns.budget")}
                  </dt>
                  <dd>
                    <Money amount={row.budgetIdr} size="sm" />
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">
                    {t("accounting.ap.budgets.columns.actual")}
                  </dt>
                  <dd>
                    <Money amount={row.actualIdr} size="sm" />
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">
                    {t("accounting.ap.budgets.columns.variancePercent")}
                  </dt>
                  <dd className="tabular text-sm">
                    {formatVarianceBp(row.varianceBp) ??
                      t("accounting.ap.budgets.variance.noBudget")}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[56rem]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("accounting.ap.budgets.columns.account")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.budgets.columns.budget")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.budgets.columns.actual")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.budgets.columns.variance")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.budgets.columns.variancePercent")}
                </TableHead>
                <TableHead>
                  {t("accounting.ap.budgets.columns.status")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.accountId}>
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="tabular text-muted-foreground">
                        {row.accountCode}
                      </span>
                      <span className="truncate font-medium">
                        {row.accountName}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.budgetIdr} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.actualIdr} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.varianceIdr} />
                  </TableCell>
                  <TableCell numeric>
                    {formatVarianceBp(row.varianceBp) ??
                      t("accounting.ap.budgets.variance.noBudget")}
                  </TableCell>
                  <TableCell>
                    <BudgetVarianceBadge varianceIdr={row.varianceIdr} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>{t("accounting.ap.aging.totalRow")}</TableCell>
                <TableCell numeric>
                  <Money amount={totals.budgetIdr} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={totals.actualIdr} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={totals.varianceIdr} />
                </TableCell>
                <TableCell numeric>{variancePercent}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </DataTableShell>

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        legalEntityId={legalEntityId}
        period={period}
        outletId={outletId}
      />
    </div>
  );
}
