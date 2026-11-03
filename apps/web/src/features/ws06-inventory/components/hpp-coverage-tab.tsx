// Recipe completeness (PRD §17 "Kelengkapan Resep"): which menus have a
// complete recipe, which are incomplete, and which have none. Menus without a
// recipe stay sellable but cannot be costed, so they are the report's action
// list (R13). Rows are grouped by the status the endpoint returns.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill, type StatusKind } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api/errors";
import type {
  RecipeCoverageRow,
  RecipeCoverageStatus,
} from "@starter/shared/inventory";
import { useRecipeCoverage } from "../hpp-hooks";
import {
  COVERAGE_STATUSES,
  allRecipesComplete,
  costIdrOf,
  coverageCounts,
  menuNameOf,
  sortRecipeCoverage,
} from "../hpp-lib";
import { formatDateTime, shortId } from "../stock-lib";

const GROUP_LABEL = {
  complete: "inventoryHpp.coverage.groups.complete",
  incomplete: "inventoryHpp.coverage.groups.incomplete",
  no_recipe: "inventoryHpp.coverage.groups.no_recipe",
} as const satisfies Record<RecipeCoverageStatus, string>;

const GROUP_STATUS: Record<RecipeCoverageStatus, StatusKind> = {
  complete: "success",
  incomplete: "warning",
  no_recipe: "danger",
};

export function HppCoverageTab() {
  const t = useT();
  const query = useRecipeCoverage();
  const rows = React.useMemo(
    () => sortRecipeCoverage(query.data?.data ?? []),
    [query.data],
  );
  const counts = React.useMemo(() => coverageCounts(rows), [rows]);
  const offline =
    query.error instanceof ApiError && query.error.code === "NETWORK_ERROR";

  if (query.isPending) {
    return (
      <CardShell>
        <CardShellBody>
          <div aria-busy="true" className="grid gap-2 p-card">
            <span className="sr-only">{t("inventoryHpp.loading")}</span>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-20 rounded-container" />
            ))}
          </div>
        </CardShellBody>
      </CardShell>
    );
  }

  if (query.isError) {
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            title={t("inventoryHpp.errors.load")}
            description={
              offline
                ? t("inventoryHpp.errors.offline")
                : t("inventoryHpp.errors.loadHint")
            }
            onRetry={() => void query.refetch()}
          />
        </CardShellBody>
      </CardShell>
    );
  }

  const complete = allRecipesComplete(rows);

  return (
    <CardShell>
      <CardShellBody>
        <header className="grid gap-0.5 border-b p-card">
          <h3 className="type-title">{t("inventoryHpp.coverage.title")}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("inventoryHpp.coverage.description")}
          </p>
        </header>

        {rows.length === 0 ? (
          <EmptyState
            title={t("inventoryHpp.coverage.emptyTitle")}
            description={t("inventoryHpp.coverage.emptyHint")}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b p-card">
              {COVERAGE_STATUSES.map((status) => (
                <StatusPill key={status} status={GROUP_STATUS[status]}>
                  {t("inventoryHpp.coverage.summary", {
                    status: t(GROUP_LABEL[status]),
                    count: counts[status],
                  })}
                </StatusPill>
              ))}
            </div>
            {complete ? (
              <EmptyState
                title={t("inventoryHpp.coverage.allCompleteTitle")}
                description={t("inventoryHpp.coverage.allCompleteHint")}
              />
            ) : (
              <div className="grid">
                {COVERAGE_STATUSES.map((status) => {
                  const group = rows.filter((row) => row.status === status);
                  if (group.length === 0) return null;
                  return (
                    <CoverageGroup key={status} status={status} rows={group} />
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardShellBody>
    </CardShell>
  );
}

function CoverageGroup({
  status,
  rows,
}: {
  status: RecipeCoverageStatus;
  rows: readonly RecipeCoverageRow[];
}) {
  const t = useT();
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-2 border-b p-card last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="type-heading">
          {t(GROUP_LABEL[status])}
        </h3>
        <Badge tone="neutral">
          {t("inventoryHpp.coverage.count", { count: rows.length })}
        </Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("inventoryHpp.coverage.columns.menu")}</TableHead>
            <TableHead numeric>
              {t("inventoryHpp.coverage.columns.cost")}
            </TableHead>
            <TableHead>{t("inventoryHpp.coverage.columns.updated")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const facet = row.variantId
              ? t("inventoryHpp.coverage.variant", {
                  id: shortId(row.variantId),
                })
              : row.modifierId
                ? t("inventoryHpp.coverage.modifier", {
                    id: shortId(row.modifierId),
                  })
                : null;
            return (
              <TableRow
                key={`${row.menuItemId}:${row.variantId ?? "-"}:${
                  row.modifierId ?? "-"
                }`}
              >
                <TableCell className="min-w-40">
                  <span className="block font-medium">
                    {menuNameOf(row.menuItemId)}
                  </span>
                  {facet && (
                    <span className="block text-xs text-muted-foreground">
                      {facet}
                    </span>
                  )}
                </TableCell>
                <TableCell numeric>
                  {row.theoreticalCostIdr === null ? (
                    "—"
                  ) : (
                    <Money amount={costIdrOf(row.theoreticalCostIdr)} />
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(row.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
