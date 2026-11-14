// Pengecualian finance (legend-4oclu): a read-only view of the rows finance
// must look at because an edge sync or a payout step did not finish cleanly.
// The summary comes from the server (it counts every row, the list is cut to
// the newest 500); nothing here adds amounts across kinds or turns an unknown
// amount into Rp0.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import { useFinanceExceptions, useFinanceExceptionsSummary } from "../hooks";
import {
  summarizeByKind,
  totalCount,
  validateRange,
  type FinanceExceptionFilters,
  type FinanceExceptionKind,
} from "../lib";
import { ExceptionsFilters, type FilterDraft } from "./exceptions-filters";
import { ExceptionsList } from "./exceptions-list";
import { ExceptionsSummary, SummarySkeleton } from "./exceptions-summary";

export function FinanceExceptionsPage({
  filters,
  onApply,
  onReset,
}: {
  filters: FinanceExceptionFilters;
  onApply: (filters: FinanceExceptionFilters) => void;
  onReset: () => void;
}) {
  const t = useT();
  const outletsQuery = useOutlets();
  const outlets = React.useMemo(
    () => outletsQuery.data ?? [],
    [outletsQuery.data],
  );
  const query = useFinanceExceptions(filters);
  const summaryQuery = useFinanceExceptionsSummary(filters);
  const invalid = validateRange(filters.from, filters.to) !== null;

  const data = query.data;
  // Cards come from the query without `kind`; the list and its count from the
  // query with it.
  const summaryData = summaryQuery.data;
  const summaries = React.useMemo(
    () => (summaryData ? summarizeByKind(summaryData.summary) : undefined),
    [summaryData],
  );
  const total = data ? totalCount(data.summary) : 0;

  const state: DataState = invalid
    ? "error"
    : query.isPending
      ? "loading"
      : query.isError
        ? "error"
        : data && data.items.length === 0
          ? "empty"
          : "ready";

  const outletName = React.useCallback(
    (outletId: string) =>
      outlets.find((outlet) => outlet.id === outletId)?.name,
    [outlets],
  );

  // Unapplied edits in the filter form: a card click keeps them when valid.
  const draftRef = React.useRef<FilterDraft | null>(null);
  const selectKind = (kind: FinanceExceptionKind | undefined) => {
    const draft = draftRef.current;
    const next =
      draft && validateRange(draft.from, draft.to) === null
        ? draft
        : {
            ...(filters.outletId ? { outletId: filters.outletId } : {}),
            from: filters.from,
            to: filters.to,
          };
    onApply({ ...(kind ? { kind } : {}), ...next });
  };

  return (
    <div className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="type-title">{t("financeExceptions.title")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("financeExceptions.subtitle")}
          </p>
        </div>
        <Badge tone="neutral">{t("financeExceptions.readOnly")}</Badge>
      </header>

      <ExceptionsFilters
        key={[filters.kind, filters.outletId, filters.from, filters.to].join(
          "|",
        )}
        applied={filters}
        outlets={outlets}
        outletsLoading={outletsQuery.isPending}
        draftRef={draftRef}
        onApply={onApply}
        onReset={onReset}
      />

      {!invalid && (
        <section
          aria-labelledby="finance-exceptions-summary"
          className="grid gap-3"
        >
          <div>
            <h3 id="finance-exceptions-summary" className="type-title">
              {t("financeExceptions.summary.title")}
            </h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("financeExceptions.summary.hint")}{" "}
              {t("financeExceptions.summary.selectHint")}
            </p>
          </div>
          {summaryQuery.isPending && <SummarySkeleton />}
          {summaryQuery.isError && (
            <ErrorState
              title={t("financeExceptions.summary.errorTitle")}
              description={t("financeExceptions.states.errorHint")}
              error={summaryQuery.error}
              onRetry={() => {
                void summaryQuery.refetch();
              }}
            />
          )}
          {summaries && (
            <ExceptionsSummary
              entries={summaries}
              activeKind={filters.kind}
              outletFiltered={filters.outletId !== undefined}
              onSelectKind={selectKind}
            />
          )}
        </section>
      )}

      <DataTableShell
        bare
        title={t("financeExceptions.list.title")}
        description={t("financeExceptions.list.hint")}
        state={state}
        error={invalid ? undefined : query.error}
        onRetry={
          invalid
            ? undefined
            : () => {
                void query.refetch();
              }
        }
        errorCopy={
          invalid
            ? {
                title: t("financeExceptions.states.invalidTitle"),
                description: t("financeExceptions.states.invalidHint"),
              }
            : {
                title: t("financeExceptions.states.errorTitle"),
                description: t("financeExceptions.states.errorHint"),
              }
        }
        empty={{
          title: t("financeExceptions.states.emptyTitle"),
          description: t("financeExceptions.states.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReset}
              className="max-sm:min-h-11"
            >
              {t("financeExceptions.filters.reset")}
            </Button>
          ),
        }}
        actions={
          // The live region stays mounted so a changed count is announced.
          <span aria-live="polite" aria-atomic="true">
            {data && (
              <Badge tone="neutral">
                {t("financeExceptions.list.count", { count: total })}
              </Badge>
            )}
          </span>
        }
      >
        {data && <ExceptionsList items={data.items} outletName={outletName} />}
        <p className="border-t border-border p-card text-sm text-muted-foreground">
          {data?.truncated
            ? t("financeExceptions.list.truncated", { total })
            : t("financeExceptions.list.allShown")}
        </p>
      </DataTableShell>
    </div>
  );
}
