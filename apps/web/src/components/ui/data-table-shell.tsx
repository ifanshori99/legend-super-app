// Frame for every list/table screen: title, toolbar (search + actions), the
// four states (loading, empty, no results, error), and pagination. Data
// fetching, sorting, and filtering stay in the feature; this owns only the
// layout and state rendering so all lists behave the same.
//
// v3 (Metoric product list): a double shell — 18px outer shell, 12px inner
// card holding toolbar, table, and pager.
import * as React from "react";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, Search, SearchX } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export type DataState = "loading" | "error" | "empty" | "ready";

type Props = {
  title?: string;
  description?: string;
  state: DataState;
  /** Controlled search; omit to hide the search field. */
  search?: { value: string; onChange: (value: string) => void; label?: string };
  actions?: React.ReactNode;
  onRetry?: () => void;
  /** The query's error; a 403 shows an explaining empty state, not a failure. */
  error?: unknown;
  empty?: { title?: string; description?: string; action?: React.ReactNode };
  /** Shown instead of `children` when `ready` but a search matched nothing. */
  noResults?: boolean;
  page?: { page: number; total: number; onChange: (page: number) => void };
  rowCount?: number;
  /** Skeleton rows while loading; match the usual page size. */
  loadingRows?: number;
  className?: string;
  children?: React.ReactNode;
};

function DataTableShell({
  title,
  description,
  state,
  search,
  actions,
  onRetry,
  error,
  empty,
  noResults = false,
  page,
  rowCount,
  loadingRows = 5,
  className,
  children,
}: Props) {
  const t = useT();
  const headingId = React.useId();
  const pageLabel =
    page && t("table.page", { page: page.page, total: page.total });
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      aria-busy={state === "loading" || undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
        {(title || search || actions) && (
          <header className="flex flex-col gap-3 border-b p-card sm:flex-row sm:items-center sm:justify-between">
            {title && (
              <div className="min-w-0">
                <h2 id={headingId} className="type-title">
                  {title}
                </h2>
                {description && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {description}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {search && (
                <div className="relative sm:w-64">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-icon -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    value={search.value}
                    onChange={(event) => search.onChange(event.target.value)}
                    placeholder={t("table.searchPlaceholder")}
                    aria-label={search.label ?? t("common.search")}
                    className="h-control-sm pl-10"
                  />
                </div>
              )}
              {actions}
            </div>
          </header>
        )}

        {/* A wide table scrolls inside its card instead of pushing the grid
            track wider than the viewport (squad invfe: the HPP/engineering and
            purchasing tables overflowed a 390px screen). */}
        <div className="min-w-0 overflow-x-auto">
          {state === "loading" && (
            <div className="grid gap-2 p-card">
              <span className="sr-only">{t("common.loading")}</span>
              {Array.from({ length: loadingRows }, (_, i) => (
                <Skeleton key={i} className="h-row" />
              ))}
            </div>
          )}
          {state === "error" && <ErrorState onRetry={onRetry} error={error} />}
          {state === "empty" && <EmptyState {...empty} />}
          {state === "ready" &&
            (noResults ? (
              <EmptyState
                icon={SearchX}
                title={t("state.noResults", { query: search?.value ?? "" })}
                description={t("state.noResultsHint")}
                action={
                  search && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => search.onChange("")}
                    >
                      {t("state.clearSearch")}
                    </Button>
                  )
                }
              />
            ) : (
              children
            ))}
        </div>

        {state === "ready" &&
          !noResults &&
          (page || rowCount !== undefined) && (
            <footer className="flex items-center justify-between gap-3 border-t px-card py-2.5 text-sm text-muted-foreground">
              <span className="tabular">
                {rowCount !== undefined &&
                  t("table.rowCount", { count: rowCount })}
              </span>
              {page && (
                <nav className="flex items-center gap-2" aria-label={pageLabel}>
                  <span className="tabular" aria-hidden="true">
                    {pageLabel}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={page.page <= 1}
                    onClick={() => page.onChange(page.page - 1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                    <span className="sr-only">{t("common.previous")}</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={page.page >= page.total}
                    onClick={() => page.onChange(page.page + 1)}
                  >
                    <ChevronRight aria-hidden="true" />
                    <span className="sr-only">{t("common.next")}</span>
                  </Button>
                </nav>
              )}
            </footer>
          )}
      </div>
    </section>
  );
}

export { DataTableShell };
