// ACC-03 drill-down: the journal lines behind one statement row. A line opens
// its posted journal, where the source document is one step away. Cursor pages
// append as the controller asks for more.
import { Link } from "@tanstack/react-router";
import { ListTree } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  JOURNAL_SOURCE_KEYS,
  LEDGER_START_DATE,
  formatBusinessDate,
  type StatementDrillTarget,
} from "../lib";
import { useOutlets, useStatementDrillDown } from "../hooks";

export function DrillDownSheet({
  target,
  onClose,
}: {
  target: StatementDrillTarget | null;
  onClose: () => void;
}) {
  const t = useT();
  const drill = useStatementDrillDown(target);
  const outletsQuery = useOutlets();
  const lines = drill.data?.pages.flatMap((page) => page.data) ?? [];
  const outletName = (outletId: string | null) => {
    if (outletId === null) return t("accounting.journal.outletNone");
    return (
      outletsQuery.data?.find((outlet) => outlet.id === outletId)?.name ??
      outletId
    );
  };

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:w-[min(36rem,calc(100%-3rem))]"
      >
        <SheetHeader className="border-b-(length:--border-w) border-border p-card">
          <SheetTitle>
            {target
              ? target.code
                ? `${target.code} · ${target.name}`
                : target.name
              : t("accounting.report.drillDown.title")}
          </SheetTitle>
          <SheetDescription>
            {t("accounting.report.drillDown.traceHint")}
          </SheetDescription>
        </SheetHeader>

        {target && (
          <div className="grid gap-1 border-b-(length:--border-w) border-border p-card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="type-eyebrow text-muted-foreground">
                {t("accounting.report.drillDown.total")}
              </span>
              <Money amount={target.amountIdr} size="lg" />
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {target.from === LEDGER_START_DATE
                ? t("accounting.report.drillDown.rangeTo", {
                    to: formatBusinessDate(target.to),
                  })
                : t("accounting.report.drillDown.range", {
                    from: formatBusinessDate(target.from),
                    to: formatBusinessDate(target.to),
                  })}
              {target.outletId ? ` · ${outletName(target.outletId)}` : ""}
            </p>
          </div>
        )}

        <div
          aria-busy={drill.isPending || undefined}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {drill.isPending && (
            <div className="grid gap-2 p-card">
              <span className="sr-only">{t("common.loading")}</span>
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-20" />
              ))}
            </div>
          )}

          {drill.isError && (
            <ErrorState
              title={t("accounting.report.drillDown.errorTitle")}
              description={t("state.errorHint")}
              onRetry={() => void drill.refetch()}
            />
          )}

          {!drill.isPending && !drill.isError && lines.length === 0 && (
            <EmptyState
              icon={ListTree}
              title={t("accounting.report.drillDown.emptyTitle")}
              description={t("accounting.report.drillDown.emptyHint")}
            />
          )}

          {lines.length > 0 && (
            <>
              <ul className="divide-y divide-border">
                {lines.map((line) => (
                  <li key={line.journalLineId}>
                    <Link
                      to="/kelola/akuntansi/jurnal/$journalEntryId"
                      params={{ journalEntryId: line.journalEntryId }}
                      className="grid gap-1 p-card transition-colors duration-(--duration-fast) hover:bg-accent/60"
                    >
                      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="text-sm text-muted-foreground tabular">
                          {formatBusinessDate(line.entryDate)}
                        </span>
                        <span className="font-mono text-xs break-all text-muted-foreground">
                          {line.journalEntryId}
                        </span>
                      </span>
                      <span className="font-medium">{line.description}</span>
                      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm text-muted-foreground">
                        <span>
                          {t(JOURNAL_SOURCE_KEYS[line.sourceType])} ·{" "}
                          {outletName(line.outletId)}
                        </span>
                        <span className="flex flex-wrap items-baseline gap-3">
                          {line.debitIdr > 0 && (
                            <span className="flex items-baseline gap-1">
                              <span className="type-eyebrow">
                                {t("accounting.report.drillDown.columns.debit")}
                              </span>
                              <Money amount={line.debitIdr} size="sm" />
                            </span>
                          )}
                          {line.creditIdr > 0 && (
                            <span className="flex items-baseline gap-1">
                              <span className="type-eyebrow">
                                {t(
                                  "accounting.report.drillDown.columns.credit",
                                )}
                              </span>
                              <Money amount={line.creditIdr} size="sm" />
                            </span>
                          )}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-card">
                <span className="text-sm text-muted-foreground tabular">
                  {t("accounting.report.drillDown.count", {
                    count: lines.length,
                  })}
                </span>
                {drill.hasNextPage && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={drill.isFetchingNextPage}
                    onClick={() => void drill.fetchNextPage()}
                  >
                    {t("accounting.report.drillDown.loadMore")}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
