// Audit log viewer (PRD v1.7 §3 F36 "Audit Log Viewer"; bead legend-max2).
// DESIGN.md v3: the ManagementShell topbar owns the page title; the screen is a
// short intro with "Muat ulang", the filter form, then the rows in one double
// shell with cursor "Muat lebih banyak" and a detail side panel.
//
// States: loading (skeleton rows), empty (no audit yet), no results (filters
// matched nothing), error and offline (separate copy, both with retry).
import { RefreshCw, ScrollText, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import type { AuditEventView } from "../contract";
import { useAuditEvents, useRefreshAudit } from "../hooks";
import { EMPTY_FILTERS, activeFilterCount, type AuditFilters } from "../lib";
import { AuditDetail } from "./audit-detail";
import {
  AuditFilterBar,
  MOCK_OUTLET_OPTIONS,
  type OutletOption,
} from "./audit-filters";
import { AuditList } from "./audit-list";

function ListSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid divide-y divide-border">
      <p className="sr-only">{t("common.loading")}</p>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="grid gap-2 px-4 py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function AuditPage({
  outlets = MOCK_OUTLET_OPTIONS,
}: {
  outlets?: readonly OutletOption[];
}) {
  const t = useT();
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<AuditEventView | null>(null);
  const query = useAuditEvents(filters);
  const refresh = useRefreshAudit();
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  const filtered = activeFilterCount(filters) > 0;
  const offline =
    query.error instanceof ApiError && query.error.code === "NETWORK_ERROR";

  let body;
  if (query.isPending) body = <ListSkeleton />;
  else if (query.isError && rows.length === 0)
    body = (
      <ErrorState
        title={
          offline
            ? t("auditSettings.audit.offline.title")
            : t("auditSettings.audit.error.title")
        }
        description={
          offline
            ? t("auditSettings.audit.offline.hint")
            : t("auditSettings.audit.error.hint")
        }
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  else if (rows.length === 0)
    body = filtered ? (
      <EmptyState
        icon={SearchX}
        title={t("auditSettings.audit.noResults.title")}
        description={t("auditSettings.audit.noResults.hint")}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            {t("auditSettings.audit.filters.reset")}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={ScrollText}
        title={t("auditSettings.audit.empty.title")}
        description={t("auditSettings.audit.empty.hint")}
      />
    );
  else
    body = (
      <>
        <AuditList rows={rows} onOpen={setSelected} />
        <div className="grid justify-items-center gap-2 border-t border-border px-4 py-4">
          {query.isFetchNextPageError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {t("auditSettings.audit.error.hint")}
            </p>
          )}
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {query.isFetchingNextPage
                ? t("auditSettings.audit.loadingMore")
                : t("auditSettings.audit.loadMore")}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("auditSettings.audit.endOfList")}
            </p>
          )}
        </div>
      </>
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
          {t("auditSettings.audit.subtitle")}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => {
            void refresh();
          }}
        >
          <RefreshCw
            className={query.isFetching ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          {t("auditSettings.audit.refresh")}
        </Button>
      </div>

      <AuditFilterBar
        // A new key per applied filter set keeps the draft in sync after "Atur ulang".
        key={JSON.stringify(filters)}
        applied={filters}
        outlets={outlets}
        onApply={setFilters}
      />

      <CardShell>
        <CardShellBody>{body}</CardShellBody>
        <CardShellFooter className="flex-wrap justify-between">
          <span>{t("auditSettings.audit.maskedNote")}</span>
          <span className="tabular">
            {rows.length > 0 &&
              t("auditSettings.audit.count", { count: rows.length })}{" "}
            {t("auditSettings.audit.timeZoneNote")}
          </span>
        </CardShellFooter>
      </CardShell>

      <AuditDetail view={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
