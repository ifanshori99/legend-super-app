// Tenant list for Super Admin (PRD §3 F1 "Layar Platform", §3 F4): status
// filter, search, cursor paging (next/previous through a cursor stack).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useDebounced, usePackages, useTenants } from "../hooks";
import {
  ALL_STATUSES,
  buildListQuery,
  TENANT_STATUS_LABEL,
  type StatusFilter,
} from "../logic";
import { TenantStatusBadge } from "./tenant-status";

const k = (key: string) => `platformTenants.list.${key}` as MessageKey;

export function TenantListPage() {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>(ALL_STATUSES);
  // cursors[i] is the cursor that opens page i + 1 (page 1 has none).
  const [cursors, setCursors] = React.useState<string[]>([]);
  const debounced = useDebounced(search);
  const cursor = cursors.at(-1);

  const filterKey = `${status}|${debounced.trim()}`;
  const lastFilter = React.useRef(filterKey);
  React.useEffect(() => {
    if (lastFilter.current !== filterKey) {
      lastFilter.current = filterKey;
      setCursors([]);
    }
  }, [filterKey]);

  const list = useTenants(
    buildListQuery({ status, search: debounced, cursor }),
  );
  const packages = usePackages();
  const packageName = (key: string) =>
    packages.data?.data.find((p) => p.key === key)?.name ?? key;

  const rows = list.data?.data ?? [];
  const nextCursor = list.data?.meta.nextCursor ?? null;
  const filtered = status !== ALL_STATUSES || debounced.trim() !== "";
  const state = list.isPending
    ? "loading"
    : list.isError && !list.data
      ? "error"
      : rows.length === 0 && !filtered
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">{t(k("subtitle"))}</p>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <Button asChild>
          <Link to="/platform/tenant/baru">
            <Plus aria-hidden="true" />
            {t(k("create"))}
          </Link>
        </Button>
      </div>

      <DataTableShell
        title={t(k("title"))}
        description={t(k("description"))}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t(k("searchLabel")),
        }}
        actions={
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as StatusFilter)}
          >
            <SelectTrigger
              className="h-control-sm sm:w-44"
              aria-label={t(k("statusFilter"))}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>{t(k("statusAll"))}</SelectItem>
              {(["active", "suspended", "archived"] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {t(TENANT_STATUS_LABEL[s])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        noResults={state === "ready" && rows.length === 0}
        onRetry={() => void list.refetch()}
        empty={{
          title: t(k("emptyTitle")),
          description: t(k("emptyHint")),
          action: (
            <Button asChild size="sm">
              <Link to="/platform/tenant/baru">{t(k("create"))}</Link>
            </Button>
          ),
        }}
        rowCount={rows.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t(k("colName"))}</TableHead>
              <TableHead className="hidden sm:table-cell">
                {t(k("colPlan"))}
              </TableHead>
              <TableHead>{t(k("colStatus"))}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t(k("colMode"))}
              </TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t(k("open"))}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    to="/platform/tenant/$tenantId"
                    params={{ tenantId: row.id }}
                    className="grid gap-0.5 font-semibold hover:underline"
                  >
                    {/* Own colour token: inheriting from the row would ride
                        TableRow's colour transition on a theme switch and
                        render dark-on-dark for a frame (legend-tno review). */}
                    <span className="text-foreground">{row.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {row.slug}
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {packageName(row.plan)}
                </TableCell>
                <TableCell>
                  <TenantStatusBadge status={row.status} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {t(
                    `platformTenants.mode.${row.deploymentMode}` as MessageKey,
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(k("open"))}
                  >
                    <Link
                      to="/platform/tenant/$tenantId"
                      params={{ tenantId: row.id }}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {(cursors.length > 0 || nextCursor) && (
          <nav
            aria-label={t(k("pager"))}
            className="flex items-center justify-between gap-3 border-t px-card py-2.5"
          >
            <span className="tabular text-sm text-muted-foreground">
              {t(k("pageNumber"), { page: cursors.length + 1 })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                <ChevronLeft aria-hidden="true" />
                {t("common.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!nextCursor}
                onClick={() =>
                  nextCursor && setCursors((c) => [...c, nextCursor])
                }
              >
                {t("common.next")}
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </nav>
        )}
      </DataTableShell>
    </div>
  );
}
