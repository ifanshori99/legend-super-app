// /kelola/akuntansi/laporan — financial statements (PRD v1.7 §3.19 "Laporan
// Keuangan": Neraca, Laba Rugi, Arus Kas, Perubahan Ekuitas, Multi-entitas,
// Laba Rugi per outlet; ACC-03 drill-down to the source transaction).
//
// The controls follow each statement's own query schema: the balance sheet is
// as-of, the P&L takes an optional outlet, cash flow and equity are entity
// ranges, the multi-entity report has no entity filter. Every statement is
// labelled official (all months it depends on are closed fiscal periods) or
// estimate (any open month), from the server's fiscal-period rows.
import * as React from "react";
import { Hourglass, Lock } from "lucide-react";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  STATEMENT_TYPES,
  STATEMENT_TYPE_KEYS,
  basisRangeFor,
  businessDateToday,
  formatPeriod,
  monthRange,
  statementBasis,
  type StatementDrillTarget,
  type StatementParams,
  type StatementType,
} from "../lib";
import { useFiscalPeriods, useOutlets } from "../hooks";
import { BalanceSheetView } from "./balance-sheet-view";
import { CashFlowView } from "./cash-flow-view";
import { DrillDownSheet } from "./drill-down-sheet";
import { EquityChangesView } from "./equity-changes-view";
import { MultiEntityView } from "./multi-entity-view";
import { ProfitAndLossView } from "./profit-and-loss-view";

const ALL_OUTLETS = "all";

export function StatementsPage({ legalEntityId }: { legalEntityId: string }) {
  const t = useT();
  const today = businessDateToday();
  const [type, setType] = React.useState<StatementType>("profitAndLoss");
  const [range, setRange] = React.useState(() => monthRange(today));
  const [outletId, setOutletId] = React.useState(ALL_OUTLETS);
  const outletFieldId = React.useId();
  const [drillTarget, setDrillTarget] =
    React.useState<StatementDrillTarget | null>(null);
  const periodsQuery = useFiscalPeriods(legalEntityId);
  const outletsQuery = useOutlets();

  const params: StatementParams = {
    from: range.from,
    to: range.to,
    ...(type === "profitAndLoss" && outletId !== ALL_OUTLETS
      ? { outletId }
      : {}),
  };

  // Official only when every month the figures depend on is closed; an open
  // month anywhere in the range (or a failed period read) means estimate.
  const basisRange = basisRangeFor(type, params);
  const basis = periodsQuery.isPending
    ? null
    : statementBasis(periodsQuery.data ?? [], basisRange.from, basisRange.to, {
        cumulative: basisRange.cumulative,
      });
  const periodList = (months: readonly string[]) =>
    months.map((month) => formatPeriod(month)).join(", ");
  const basisNote = !basis
    ? null
    : basis.basis === "official"
      ? t("accounting.report.basis.officialNote", {
          periods: periodList(basis.closed),
        })
      : basis.open.length === 0
        ? t("accounting.report.basis.estimateUnknownNote")
        : basis.closed.length > 0
          ? t("accounting.report.basis.estimateMixedNote", {
              open: periodList(basis.open),
              closed: periodList(basis.closed),
            })
          : t("accounting.report.basis.estimateNote", {
              open: periodList(basis.open),
            });

  const resetRange = () => {
    setRange(monthRange(today));
    setOutletId(ALL_OUTLETS);
  };

  const viewProps = {
    legalEntityId,
    params,
    onDrillDown: setDrillTarget,
    onResetRange: resetRange,
    basis: basis?.basis ?? null,
  };

  return (
    <div className="grid min-w-0 gap-5">
      <CardShell>
        <CardShellBody className="gap-4 p-card">
          <div className="grid gap-2">
            <p className="type-eyebrow text-muted-foreground">
              {t("accounting.report.screen.statementType")}
            </p>
            <SegmentedControl
              value={type}
              onValueChange={setType}
              label={t("accounting.report.screen.statementType")}
              className="w-full sm:w-fit"
              options={STATEMENT_TYPES.map((statementType) => ({
                value: statementType,
                label: t(STATEMENT_TYPE_KEYS[statementType]),
              }))}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {type === "balanceSheet" ? (
              <FormField label={t("accounting.report.screen.asOf")} required>
                <Input
                  type="date"
                  value={range.to}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRange((current) => ({
                      from: value < current.from ? value : current.from,
                      to: value,
                    }));
                  }}
                  className="tabular"
                />
              </FormField>
            ) : (
              <>
                <FormField label={t("accounting.report.screen.from")} required>
                  <Input
                    type="date"
                    value={range.from}
                    max={range.to}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRange((current) => ({
                        from: value,
                        to: value > current.to ? value : current.to,
                      }));
                    }}
                    className="tabular"
                  />
                </FormField>
                <FormField label={t("accounting.report.screen.to")} required>
                  <Input
                    type="date"
                    value={range.to}
                    min={range.from}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRange((current) => ({
                        from: value < current.from ? value : current.from,
                        to: value,
                      }));
                    }}
                    className="tabular"
                  />
                </FormField>
              </>
            )}

            {type === "profitAndLoss" && (
              <FormField
                id={outletFieldId}
                label={t("accounting.report.screen.outlet")}
                hint={t("accounting.report.screen.outletHint")}
              >
                <Select value={outletId} onValueChange={setOutletId}>
                  <SelectTrigger
                    id={outletFieldId}
                    aria-describedby={`${outletFieldId}-hint`}
                    className="h-control-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_OUTLETS}>
                      {t("accounting.report.screen.outletAll")}
                    </SelectItem>
                    {(outletsQuery.data ?? []).map((outlet) => (
                      <SelectItem key={outlet.id} value={outlet.id}>
                        {outlet.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
          </div>

          {basis && basisNote && type !== "multiEntity" && (
            <div
              role="note"
              data-basis={basis.basis}
              className={
                basis.basis === "official"
                  ? "flex items-start gap-2 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3"
                  : "flex items-start gap-2 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-3"
              }
            >
              {basis.basis === "official" ? (
                <Lock
                  className="mt-0.5 size-icon shrink-0 text-success"
                  aria-hidden="true"
                />
              ) : (
                <Hourglass
                  className="mt-0.5 size-icon shrink-0 text-warning"
                  aria-hidden="true"
                />
              )}
              <div className="grid gap-0.5 text-sm leading-5">
                <p className="font-semibold">
                  {t(
                    basis.basis === "official"
                      ? "accounting.report.basis.officialTitle"
                      : "accounting.report.basis.estimateTitle",
                  )}
                </p>
                <p className="text-muted-foreground">{basisNote}</p>
              </div>
            </div>
          )}
        </CardShellBody>
      </CardShell>

      {type === "profitAndLoss" && <ProfitAndLossView {...viewProps} />}
      {type === "balanceSheet" && <BalanceSheetView {...viewProps} />}
      {type === "cashFlow" && <CashFlowView {...viewProps} />}
      {type === "equityChanges" && <EquityChangesView {...viewProps} />}
      {type === "multiEntity" && <MultiEntityView {...viewProps} />}

      <DrillDownSheet
        target={drillTarget}
        onClose={() => setDrillTarget(null)}
      />
    </div>
  );
}
