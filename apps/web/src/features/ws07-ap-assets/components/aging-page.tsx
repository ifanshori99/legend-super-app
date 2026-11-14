// Utang & Piutang (PRD v1.7 §3.19 "Utang & Piutang [P0] — Kartu utang supplier
// dengan umur utang, serta piutang untuk event dan corporate account"). One
// screen for both sides of the aging report: the kind switch changes the
// report, the StatStrip summarises it, and the table expands a counterparty
// into its bucket breakdown.
import * as React from "react";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import type { OpenItemKind } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Label } from "@/components/ui/label";
import { Money, NumberDisplay } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
  formatBusinessDate,
} from "@/features/ws07-accounting/lib";
import { useAgingReport } from "../hooks";
import {
  agingBucketDescriptors,
  agingRowOverdueIdr,
  agingRowsTotals,
  agingSummary,
  filterAgingRows,
  type AgingBucketDescriptor,
} from "../lib";
import { useHydrated } from "@/features/ws10-attendance-qr/use-hydrated";
import { AgingRowStatusBadge } from "./status-badge";

const KINDS: readonly OpenItemKind[] = ["payable", "receivable"];

export function AgingPage({ legalEntityId }: { legalEntityId: string }) {
  const hydrated = useHydrated();
  const t = useT();
  const [kind, setKind] = React.useState<OpenItemKind>("payable");
  const [search, setSearch] = React.useState("");
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const asOf = React.useMemo(
    () => (hydrated ? businessDateToday() : ""),
    [hydrated],
  );
  const reportQuery = useAgingReport({
    legalEntityId,
    kind,
    asOf,
  });
  const report = reportQuery.data;

  const descriptors = React.useMemo(
    () => (report ? agingBucketDescriptors(report.bucketLabels) : []),
    [report],
  );
  const summary = React.useMemo(
    () => (report ? agingSummary(report) : null),
    [report],
  );
  const visibleRows = React.useMemo(
    () =>
      report
        ? filterAgingRows(report.rows, { query: search, overdueOnly })
        : [],
    [report, search, overdueOnly],
  );
  const totals = React.useMemo(
    () => agingRowsTotals(visibleRows),
    [visibleRows],
  );

  const bucketLabel = React.useCallback(
    (bucket: AgingBucketDescriptor): string => {
      if (bucket.kind === "current")
        return t("accounting.ap.aging.buckets.current");
      if (bucket.kind === "range")
        return t("accounting.ap.aging.buckets.range", {
          from: bucket.from,
          to: bucket.to,
        });
      return t("accounting.ap.aging.buckets.over", { days: bucket.days });
    },
    [t],
  );

  const toggleRow = (counterpartyId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(counterpartyId)) next.delete(counterpartyId);
      else next.add(counterpartyId);
      return next;
    });
  };

  const state: DataState = reportQuery.isPending
    ? "loading"
    : reportQuery.isError
      ? "error"
      : (report?.rows.length ?? 0) === 0
        ? "empty"
        : "ready";
  const title =
    kind === "payable"
      ? t("accounting.ap.aging.title.payable")
      : t("accounting.ap.aging.title.receivable");
  const emptyTitle =
    kind === "payable"
      ? t("accounting.ap.aging.emptyTitle.payable")
      : t("accounting.ap.aging.emptyTitle.receivable");
  const filtered =
    search.trim() !== "" || overdueOnly ? visibleRows.length === 0 : false;

  const detail = (
    scope: "mobile" | "desktop",
    rowId: string,
    buckets: readonly number[],
  ) => (
    <div id={`${scope}-aging-detail-${rowId}`} className="grid gap-3">
      <div className="grid gap-1">
        <p className="text-sm font-semibold">
          {t("accounting.ap.aging.detail.label")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("accounting.ap.aging.detail.hint")}
        </p>
      </div>
      <dl className="grid gap-2 sm:grid-cols-5">
        {descriptors.map((bucket) => (
          <div key={bucket.label} className="grid gap-0.5">
            <dt className="text-xs leading-4 text-muted-foreground">
              {bucketLabel(bucket)}
            </dt>
            <dd>
              <Money amount={buckets[bucket.index] ?? 0} size="sm" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={kind}
          onValueChange={setKind}
          options={KINDS.map((value) => ({
            value,
            label:
              value === "payable"
                ? t("accounting.ap.kind.payable")
                : t("accounting.ap.kind.receivable"),
          }))}
          label={t("accounting.ap.kind.label")}
        />
        <p className="text-sm leading-5 text-muted-foreground">
          {asOf &&
            t("accounting.ap.aging.asOf", {
              date: formatBusinessDate(asOf),
            })}
        </p>
      </div>

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
      ) : report && summary ? (
        <>
          <StatStrip label={title} columns={4}>
            <StatTile
              label={t("accounting.ap.aging.stats.total")}
              value={<Money amount={summary.totalIdr} size="stat" />}
              context={t("accounting.ap.aging.stats.context", {
                date: formatBusinessDate(asOf),
              })}
            />
            <StatTile
              label={t("accounting.ap.aging.stats.overdue")}
              value={<Money amount={summary.overdueIdr} size="stat" />}
              context={t("accounting.ap.aging.stats.context", {
                date: formatBusinessDate(asOf),
              })}
            />
            <StatTile
              label={t("accounting.ap.aging.stats.current")}
              value={<Money amount={summary.currentIdr} size="stat" />}
              context={t("accounting.ap.aging.stats.context", {
                date: formatBusinessDate(asOf),
              })}
            />
            <StatTile
              label={t("accounting.ap.aging.stats.counterparties")}
              value={
                <NumberDisplay value={summary.counterpartyCount} size="stat" />
              }
              context={t("accounting.ap.aging.stats.context", {
                date: formatBusinessDate(asOf),
              })}
            />
          </StatStrip>
          <div
            className="flex flex-wrap gap-2"
            aria-label={t("accounting.ap.aging.detail.label")}
          >
            {descriptors.map((bucket) => {
              const count = summary.bucketCounts[bucket.index] ?? 0;
              return (
                <Badge
                  key={bucket.label}
                  tone={bucket.index > 0 && count > 0 ? "warning" : "neutral"}
                >
                  {t("accounting.ap.aging.bucketCount", {
                    label: bucketLabel(bucket),
                    count,
                  })}
                </Badge>
              );
            })}
          </div>
        </>
      ) : null}

      <DataTableShell
        title={title}
        description={
          kind === "payable"
            ? t("accounting.ap.aging.subtitle.payable")
            : t("accounting.ap.aging.subtitle.receivable")
        }
        state={state}
        onRetry={() => {
          void reportQuery.refetch();
        }}
        search={{
          value: search,
          onChange: setSearch,
          label: t("accounting.ap.aging.search"),
        }}
        actions={
          <div className="flex items-center gap-2">
            <Checkbox
              id="aging-overdue-only"
              checked={overdueOnly}
              onCheckedChange={(value) => setOverdueOnly(value === true)}
            />
            <Label htmlFor="aging-overdue-only">
              {t("accounting.ap.aging.overdueOnly")}
            </Label>
          </div>
        }
        noResults={filtered}
        rowCount={visibleRows.length}
        loadingRows={4}
        empty={{
          title: emptyTitle,
          description: t("accounting.ap.aging.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void reportQuery.refetch();
              }}
            >
              <RotateCw aria-hidden="true" />
              {t("accounting.ap.aging.reload")}
            </Button>
          ),
        }}
      >
        <ul className="divide-y divide-border md:hidden">
          {visibleRows.map((row) => {
            const isOpen = expanded.has(row.counterpartyId);
            return (
              <li key={row.counterpartyId} className="grid gap-2 p-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="grid min-w-0 gap-1">
                    <span className="truncate font-medium">
                      {row.counterpartyName}
                    </span>
                    <AgingRowStatusBadge
                      overdue={agingRowOverdueIdr(row) > 0}
                    />
                  </div>
                  <Money amount={row.totalIdr} />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {descriptors
                    .filter((bucket) => (row.buckets[bucket.index] ?? 0) > 0)
                    .map((bucket) => (
                      <span
                        key={bucket.label}
                        className="inline-flex items-center gap-1"
                      >
                        {bucketLabel(bucket)}
                        <Money
                          amount={row.buckets[bucket.index] ?? 0}
                          size="sm"
                        />
                      </span>
                    ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  aria-expanded={isOpen}
                  aria-controls={`mobile-aging-detail-${row.counterpartyId}`}
                  aria-label={`${
                    isOpen
                      ? t("accounting.ap.aging.collapse")
                      : t("accounting.ap.aging.expand")
                  } ${row.counterpartyName}`}
                  onClick={() => toggleRow(row.counterpartyId)}
                >
                  {isOpen ? (
                    <ChevronDown aria-hidden="true" />
                  ) : (
                    <ChevronRight aria-hidden="true" />
                  )}
                  {isOpen
                    ? t("accounting.ap.aging.collapse")
                    : t("accounting.ap.aging.expand")}
                </Button>
                {isOpen && detail("mobile", row.counterpartyId, row.buckets)}
              </li>
            );
          })}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[52rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">
                    {t("accounting.ap.aging.columns.action")}
                  </span>
                </TableHead>
                <TableHead>
                  {t("accounting.ap.aging.columns.counterparty")}
                </TableHead>
                {descriptors.map((bucket) => (
                  <TableHead key={bucket.label} numeric>
                    {bucketLabel(bucket)}
                  </TableHead>
                ))}
                <TableHead numeric>
                  {t("accounting.ap.aging.columns.total")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const isOpen = expanded.has(row.counterpartyId);
                const overdue = agingRowOverdueIdr(row) > 0;
                return (
                  <React.Fragment key={row.counterpartyId}>
                    <TableRow data-state={isOpen ? "selected" : undefined}>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-expanded={isOpen}
                          aria-controls={`desktop-aging-detail-${row.counterpartyId}`}
                          aria-label={`${
                            isOpen
                              ? t("accounting.ap.aging.collapse")
                              : t("accounting.ap.aging.expand")
                          } ${row.counterpartyName}`}
                          onClick={() => toggleRow(row.counterpartyId)}
                        >
                          {isOpen ? (
                            <ChevronDown aria-hidden="true" />
                          ) : (
                            <ChevronRight aria-hidden="true" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <div className="grid gap-1">
                          <span className="font-medium">
                            {row.counterpartyName}
                          </span>
                          <AgingRowStatusBadge overdue={overdue} />
                        </div>
                      </TableCell>
                      {descriptors.map((bucket) => {
                        const amount = row.buckets[bucket.index] ?? 0;
                        return (
                          <TableCell key={bucket.label} numeric>
                            {amount === 0 ? (
                              <span className="text-muted-foreground">–</span>
                            ) : (
                              <Money amount={amount} />
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell numeric>
                        <Money amount={row.totalIdr} />
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-surface-2 hover:bg-surface-2">
                        <TableCell
                          colSpan={descriptors.length + 3}
                          className="whitespace-normal"
                        >
                          {detail("desktop", row.counterpartyId, row.buckets)}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>
                  {t("accounting.ap.aging.totalRow")}
                </TableCell>
                {totals.buckets.map((amount, index) => (
                  <TableCell key={index} numeric>
                    <Money amount={amount} />
                  </TableCell>
                ))}
                <TableCell numeric>
                  <Money amount={totals.totalIdr} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </DataTableShell>
    </div>
  );
}
