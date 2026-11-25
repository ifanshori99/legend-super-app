import { useId, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { BellRing, RotateCw, Search } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useCaptainTables,
  useOrderingConnectivity,
  useServiceCalls,
} from "@/features/ws04-pos-order/hooks";
import type { CaptainTable } from "@/features/ws04-pos-order/types";
import { useTenantContext } from "@/lib/tenant-context";
import { CallBanner } from "./call-banner";
import { CaptainShell } from "./captain-shell";
import { TableTile } from "./table-tile";
import { UnclearSends } from "./unclear-sends";

type Filter = "all" | "occupied" | "empty";
const FILTERS: readonly Filter[] = ["all", "occupied", "empty"];

function matches(table: CaptainTable, filter: Filter, query: string): boolean {
  if (filter !== "all" && table.status !== filter) return false;
  const needle = query.trim().toLowerCase();
  return needle === "" || table.label.toLowerCase().includes(needle);
}

// /pos/captain — pick the table to take an order for. Search by number, filter
// by occupied or empty; the newest waiter call sits on top, and the bottom bar
// opens the call list.
export function TablesScreen() {
  const t = useT();
  const searchId = useId();
  const outlet = useTenantContext().outlet;
  const { mode } = useOrderingConnectivity();
  const tablesQuery = useCaptainTables();
  const callsQuery = useServiceCalls();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const tables = tablesQuery.data;
  const newCalls = useMemo(
    () =>
      (callsQuery.data ?? [])
        .filter((call) => call.status === "new")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [callsQuery.data],
  );
  const latest = newCalls[0];
  const latestZone =
    (latest && tables?.find((table) => table.id === latest.tableId)?.zone) ??
    null;
  const visible = useMemo(
    () => (tables ?? []).filter((table) => matches(table, filter, query)),
    [tables, filter, query],
  );

  const zones = new Set((tables ?? []).map((table) => table.zone));
  const subtitle = [outlet?.name, zones.size === 1 ? [...zones][0] : null]
    .filter(Boolean)
    .join(" · ");

  const callsLabel =
    newCalls.length > 0
      ? t("posCaptainTables.tables.callsButtonNew", { count: newCalls.length })
      : t("posCaptainTables.tables.callsButton");

  const retry = () => void tablesQuery.refetch();

  return (
    <CaptainShell
      context={t("posCaptainTables.shell.context")}
      contextSub={subtitle || undefined}
      title={t("posCaptainTables.tables.title")}
      subtitle={t("posCaptainTables.tables.subtitle")}
      bottomBar={
        <Button asChild variant="outline" size="lg" className="w-full">
          <Link to="/pos/captain/panggilan">
            <BellRing aria-hidden="true" />
            {callsLabel}
          </Link>
        </Button>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {mode === "edge_only" && (
          <Notice tone="warning" title={t("posCaptainTables.offline.title")}>
            {t("posCaptainTables.offline.body")}
          </Notice>
        )}

        <UnclearSends tables={tables} />

        {/* Always in the page, so a call that arrives later is announced. */}
        <div aria-live="polite" className="empty:sr-only">
          {latest && (
            <CallBanner
              call={latest}
              zone={latestZone}
              moreCount={newCalls.length - 1}
            />
          )}
        </div>

        {tablesQuery.isError && tables && (
          <Notice tone="warning" title={t("posCaptainTables.tables.stale")} />
        )}

        {tablesQuery.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("posCaptainTables.tables.loading")}
            className="grid gap-4"
          >
            <Skeleton className="h-control w-full" />
            <Skeleton className="h-control w-2/3" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[0, 1, 2, 3].map((n) => (
                <Skeleton key={n} className="h-28 rounded-container" />
              ))}
            </div>
          </div>
        ) : tablesQuery.isError && !tables ? (
          <ErrorState
            error={tablesQuery.error}
            title={
              isContractPending(tablesQuery.error)
                ? t("posCaptainTables.tables.error.pendingTitle")
                : t("posCaptainTables.tables.error.title")
            }
            description={
              isContractPending(tablesQuery.error)
                ? t("posCaptainTables.tables.error.pendingDescription")
                : t("posCaptainTables.tables.error.description")
            }
            action={
              <Button variant="outline" onClick={retry}>
                <RotateCw aria-hidden="true" />
                {t("posCaptainTables.tables.error.retry")}
              </Button>
            }
          />
        ) : !tables || tables.length === 0 ? (
          <EmptyState
            title={t("posCaptainTables.tables.empty.title")}
            description={t("posCaptainTables.tables.empty.description")}
          />
        ) : (
          <>
            <div className="relative">
              <label htmlFor={searchId} className="sr-only">
                {t("posCaptainTables.tables.searchLabel")}
              </label>
              <Search
                className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id={searchId}
                type="search"
                inputMode="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("posCaptainTables.tables.searchPlaceholder")}
                className="pl-11"
              />
            </div>

            <div
              role="group"
              aria-label={t("posCaptainTables.tables.filterLabel")}
              className="grid grid-cols-3 gap-2"
            >
              {FILTERS.map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="outline"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "h-auto min-h-control min-w-0 px-3 py-2 leading-5 font-bold whitespace-normal",
                    filter === value && "border-foreground bg-surface-3",
                  )}
                >
                  {t(`posCaptainTables.tables.filter.${value}`)}
                </Button>
              ))}
            </div>

            {visible.length === 0 ? (
              <EmptyState
                title={t("posCaptainTables.tables.noMatch.title")}
                description={t("posCaptainTables.tables.noMatch.description")}
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    {t("posCaptainTables.tables.noMatch.reset")}
                  </Button>
                }
              />
            ) : (
              <ul
                aria-label={t("posCaptainTables.tables.listLabel")}
                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
              >
                {visible.map((table) => (
                  <li key={table.id} className="min-w-0">
                    <TableTile table={table} />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm text-muted-foreground">
              {t("posCaptainTables.tables.legend")}
            </p>
          </>
        )}
      </div>
    </CaptainShell>
  );
}
