// Unified approval inbox (PRD v1.7 §3 F7 / F36 Kotak Approval, F38 Draf Aksi;
// MCP-04 UI): requests from every module, including AI and MCP drafts, with
// filters, deadline countdown and a detail drawer. Cards on phones, a table
// from md up.
import * as React from "react";
import { FilterX } from "lucide-react";
import type { ApprovalSource } from "@starter/shared/access";
import type { ApprovalRequestStatus } from "@starter/shared/identity";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AreaAccess } from "@/lib/areas/access";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useApprovals, useNow } from "../hooks";
import {
  APPROVAL_MODULES,
  DEADLINE_FILTERS,
  DEFAULT_FILTERS,
  STATUSES,
  applyClientFilters,
  filtersAreDefault,
  moduleLabelKey,
  sortInbox,
  sourceLabelKey,
  statusLabelKey,
  type DeadlineFilter,
  type InboxFilters,
} from "../logic.ts";
import { ApprovalCard } from "./approval-card";
import { ApprovalTable } from "./approval-table";
import { ApprovalDrawer } from "./approval-detail";
import type { ApprovalRequest } from "@starter/shared/identity";

const ALL = "all";

export function ApprovalInboxPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const now = useNow();
  const [filters, setFilters] = React.useState<InboxFilters>(DEFAULT_FILTERS);
  const [open, setOpen] = React.useState<ApprovalRequest | null>(null);
  const query = useApprovals(filters);
  const set = (patch: Partial<InboxFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));

  const rows = React.useMemo(
    () => sortInbox(applyClientFilters(query.rows, filters, now)),
    [query.rows, filters, now],
  );
  const offline =
    query.error instanceof ApiError && query.error.code === "NETWORK_ERROR";

  const state = query.isPending ? "loading" : "ready";

  const sourceOptions = [
    { value: ALL, label: t("approvals.filter.allSources") },
    ...(["user", "ai", "mcp"] as ApprovalSource[]).map((value) => ({
      value,
      label: t(sourceLabelKey(value)),
    })),
  ];

  const filtersBar = (
    <div className="flex flex-col gap-2 border-b p-card md:flex-row md:flex-wrap md:items-center">
      <Select
        value={filters.status}
        onValueChange={(value) =>
          set({ status: value as ApprovalRequestStatus | "all" })
        }
      >
        <SelectTrigger
          className="h-control-sm md:w-44"
          aria-label={t("approvals.filter.status")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>
            {t("approvals.filter.allStatuses")}
          </SelectItem>
          {STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(statusLabelKey(value))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.module}
        onValueChange={(value) =>
          set({ module: value as InboxFilters["module"] })
        }
      >
        <SelectTrigger
          className="h-control-sm md:w-44"
          aria-label={t("approvals.filter.module")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>
            {t("approvals.filter.allModules")}
          </SelectItem>
          {APPROVAL_MODULES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(moduleLabelKey(value))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.deadline}
        onValueChange={(value) => set({ deadline: value as DeadlineFilter })}
      >
        <SelectTrigger
          className="h-control-sm md:w-48"
          aria-label={t("approvals.filter.deadline")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEADLINE_FILTERS.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`approvals.filter.deadlineOption.${value}` as MessageKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SegmentedControl
        label={t("approvals.filter.source")}
        value={filters.source}
        options={sourceOptions}
        onValueChange={(value) =>
          set({ source: value as InboxFilters["source"] })
        }
      />
      {!filtersAreDefault(filters) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters(DEFAULT_FILTERS)}
        >
          <FilterX aria-hidden="true" />
          {t("approvals.filter.reset")}
        </Button>
      )}
    </div>
  );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t("approvals.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      <DataTableShell
        title={t("approvals.title")}
        state={state}
        onRetry={() => void query.refetch()}
        rowCount={state === "ready" && !query.isError ? rows.length : undefined}
        loadingRows={4}
      >
        {filtersBar}
        {query.isError ? (
          <ErrorState
            title={t(
              offline ? "approvals.offline.title" : "approvals.error.title",
            )}
            description={t(
              offline ? "approvals.offline.hint" : "approvals.error.hint",
            )}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t(
              filtersAreDefault(filters)
                ? "approvals.empty.title"
                : "approvals.noMatch.title",
            )}
            description={t(
              filtersAreDefault(filters)
                ? "approvals.empty.hint"
                : "approvals.noMatch.hint",
            )}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <ApprovalTable rows={rows} now={now} onOpen={setOpen} />
            </div>
            <ul className="grid gap-3 p-card md:hidden">
              {rows.map((request) => (
                <li key={request.id}>
                  <ApprovalCard request={request} now={now} onOpen={setOpen} />
                </li>
              ))}
            </ul>
            {query.hasNextPage && (
              <div className="flex justify-center border-t p-card">
                <Button
                  variant="outline"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {t("approvals.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </DataTableShell>

      <ApprovalDrawer
        request={open}
        access={access}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
