// Remake & comp log (PRD §3 F12 "Remake & Comp", KDS-07): every record with
// its standard reason, station, staff member and ingredient cost. The log is
// cursor-paginated; a table on desktop becomes cards on a phone.
import * as React from "react";
import { formatNumber } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import {
  stationIdSchema,
  type OrderIssueView,
  type OrderIssueType,
} from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
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
import { useMenuStations, useOrderIssues } from "../hooks.ts";
import type { OrderIssueQuery } from "../api.ts";
import { formatOutletDateTime } from "../format.ts";

const ALL = "all";

const TYPE_LABEL: Record<OrderIssueType, MessageKey> = {
  unfulfillable: "kitchenConfig.remake.types.unfulfillable",
  remake: "kitchenConfig.remake.types.remake",
  comp: "kitchenConfig.remake.types.comp",
  complaint: "kitchenConfig.remake.types.complaint",
};

const TYPE_TONE: Record<
  OrderIssueType,
  "neutral" | "warning" | "info" | "danger"
> = {
  remake: "warning",
  comp: "info",
  complaint: "neutral",
  unfulfillable: "danger",
};

const REASON_LABEL: Record<OrderIssueView["reason"], MessageKey> = {
  wrong_order: "kitchenConfig.remake.reasons.wrong_order",
  quality: "kitchenConfig.remake.reasons.quality",
  late: "kitchenConfig.remake.reasons.late",
  complaint: "kitchenConfig.remake.reasons.complaint",
  out_of_stock: "kitchenConfig.remake.reasons.out_of_stock",
  other: "kitchenConfig.remake.reasons.other",
};

const RESOLUTION_LABEL: Record<
  NonNullable<OrderIssueView["resolution"]>,
  MessageKey
> = {
  swap: "kitchenConfig.remake.resolutions.swap",
  voucher: "kitchenConfig.remake.resolutions.voucher",
  manual_refund: "kitchenConfig.remake.resolutions.manual_refund",
};

export function RemakeCompPage() {
  const t = useT();
  const outletId = useTenantContext().outlet?.id ?? null;
  const stations = useMenuStations(outletId);
  const [type, setType] = React.useState<OrderIssueType | typeof ALL>(ALL);
  const [station, setStation] = React.useState<string>(ALL);
  // Cursor stack: index 0 is the first page; the last entry is the open page.
  const [cursors, setCursors] = React.useState<(string | undefined)[]>([
    undefined,
  ]);
  const cursor = cursors.at(-1);

  const query: OrderIssueQuery = {
    limit: 20,
    ...(cursor ? { cursor } : {}),
    ...(type === ALL ? {} : { type }),
    ...(station === ALL ? {} : { stationId: stationIdSchema.parse(station) }),
  };
  const issues = useOrderIssues(outletId, query);
  const rows = issues.data?.data ?? [];
  const nextCursor = issues.data?.meta.nextCursor ?? null;
  const filtered = type !== ALL || station !== ALL;

  const stationNames = new Map(
    (stations.data ?? []).map((row) => [row.id, row.name]),
  );

  function resetPages() {
    setCursors([undefined]);
  }

  function clearFilters() {
    setType(ALL);
    setStation(ALL);
    resetPages();
  }

  function stationLabel(issue: OrderIssueView): string {
    if (issue.stationId === null) return t("kitchenConfig.remake.noStation");
    return (
      stationNames.get(issue.stationId) ??
      t("kitchenConfig.capacity.unknownStation")
    );
  }

  function typeBadge(issue: OrderIssueView) {
    return (
      <Badge tone={TYPE_TONE[issue.type]}>{t(TYPE_LABEL[issue.type])}</Badge>
    );
  }

  function staffRef(issue: OrderIssueView) {
    if (issue.employeeName === null)
      return <span className="text-muted-foreground">—</span>;
    return <span className="break-words">{issue.employeeName}</span>;
  }

  function staffCell(issue: OrderIssueView) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {staffRef(issue)}
        {issue.approvedByName !== null && (
          <span className="text-xs text-muted-foreground">
            {t("kitchenConfig.remake.approved")} {issue.approvedByName}
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      <Card
        aria-label={t("kitchenConfig.remake.title")}
        className="grid gap-3 sm:grid-cols-2"
      >
        <div className="grid gap-1.5">
          <span id="remake-type-label" className="text-sm font-semibold">
            {t("kitchenConfig.remake.filterType")}
          </span>
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value as OrderIssueType | typeof ALL);
              resetPages();
            }}
          >
            <SelectTrigger aria-labelledby="remake-type-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("kitchenConfig.remake.allTypes")}
              </SelectItem>
              {(Object.keys(TYPE_LABEL) as OrderIssueType[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(TYPE_LABEL[value])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <span id="remake-station-label" className="text-sm font-semibold">
            {t("kitchenConfig.remake.filterStation")}
          </span>
          <Select
            value={station}
            onValueChange={(value) => {
              setStation(value);
              resetPages();
            }}
          >
            <SelectTrigger aria-labelledby="remake-station-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("kitchenConfig.remake.allStations")}
              </SelectItem>
              {(stations.data ?? []).map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {issues.isError && !issues.data ? (
        <ErrorState
          title={t("kitchenConfig.remake.errorTitle")}
          description={t("kitchenConfig.remake.errorHint")}
          error={issues.error}
          onRetry={() => void issues.refetch()}
        />
      ) : (
        <DataTableShell
          title={t("kitchenConfig.remake.title")}
          description={t("kitchenConfig.remake.description")}
          state={
            issues.isPending ? "loading" : rows.length === 0 ? "empty" : "ready"
          }
          error={issues.error}
          onRetry={() => void issues.refetch()}
          empty={
            filtered
              ? {
                  title: t("kitchenConfig.remake.filteredTitle"),
                  description: t("kitchenConfig.remake.filteredHint"),
                  action: (
                    <Button variant="outline" onClick={clearFilters}>
                      {t("kitchenConfig.remake.clearFilters")}
                    </Button>
                  ),
                }
              : {
                  title: t("kitchenConfig.remake.emptyTitle"),
                  description: t("kitchenConfig.remake.emptyHint"),
                }
          }
          loadingRows={6}
        >
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("kitchenConfig.remake.columns.time")}
                  </TableHead>
                  <TableHead>
                    {t("kitchenConfig.remake.columns.type")}
                  </TableHead>
                  <TableHead>
                    {t("kitchenConfig.remake.columns.reason")}
                  </TableHead>
                  <TableHead>
                    {t("kitchenConfig.remake.columns.station")}
                  </TableHead>
                  <TableHead>
                    {t("kitchenConfig.remake.columns.employee")}
                  </TableHead>
                  <TableHead>
                    {t("kitchenConfig.remake.columns.resolution")}
                  </TableHead>
                  <TableHead numeric>
                    {t("kitchenConfig.remake.columns.cost")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((issue) => (
                  <TableRow key={issue.id}>
                    <TableCell className="whitespace-nowrap tabular">
                      <span className="block">
                        {formatOutletDateTime(issue.createdAt)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t("kitchenConfig.remake.orderRef", {
                          ref: issue.orderLabel,
                        })}
                      </span>
                    </TableCell>
                    <TableCell>{typeBadge(issue)}</TableCell>
                    <TableCell className="max-w-72">
                      <span className="block font-medium break-words">
                        {issue.itemName}
                      </span>
                      <span className="block font-medium">
                        {t(REASON_LABEL[issue.reason])}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {issue.reasonNote}
                      </span>
                    </TableCell>
                    <TableCell>{stationLabel(issue)}</TableCell>
                    <TableCell>{staffCell(issue)}</TableCell>
                    <TableCell>
                      {issue.resolution === null
                        ? t("kitchenConfig.remake.none")
                        : t(RESOLUTION_LABEL[issue.resolution])}
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={issue.costIdr} size="sm" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="md:hidden">
            {rows.map((issue) => (
              <li
                key={issue.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {typeBadge(issue)}
                  <span className="text-sm text-muted-foreground tabular">
                    {formatOutletDateTime(issue.createdAt)}
                  </span>
                </div>
                <div className="grid gap-0.5">
                  <span className="font-medium break-words">
                    {issue.itemName}
                  </span>
                  <span className="text-sm text-muted-foreground break-words">
                    {t("kitchenConfig.remake.orderRef", {
                      ref: issue.orderLabel,
                    })}
                  </span>
                  <span className="font-medium">
                    {t(REASON_LABEL[issue.reason])}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {issue.reasonNote}
                  </span>
                </div>
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("kitchenConfig.remake.columns.station")}:
                    </dt>
                    <dd className="min-w-0 break-words">
                      {stationLabel(issue)}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("kitchenConfig.remake.columns.employee")}:
                    </dt>
                    <dd className="min-w-0">{staffRef(issue)}</dd>
                  </div>
                  {issue.approvedByName !== null && (
                    <div className="col-span-2 flex min-w-0 gap-1">
                      <dt className="text-muted-foreground">
                        {t("kitchenConfig.remake.approved")}:
                      </dt>
                      <dd className="min-w-0 break-words">
                        {issue.approvedByName}
                      </dd>
                    </div>
                  )}
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("kitchenConfig.remake.columns.resolution")}:
                    </dt>
                    <dd className="min-w-0">
                      {issue.resolution === null
                        ? t("kitchenConfig.remake.none")
                        : t(RESOLUTION_LABEL[issue.resolution])}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("kitchenConfig.remake.columns.cost")}:
                    </dt>
                    <dd className="min-w-0">
                      <Money amount={issue.costIdr} size="sm" />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-card py-2 text-sm text-muted-foreground">
            <span className="tabular">
              {t("kitchenConfig.remake.rowCount", {
                count: formatNumber(rows.length),
              })}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length <= 1 || issues.isFetching}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                {t("common.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={nextCursor === null || issues.isFetching}
                onClick={() =>
                  nextCursor &&
                  setCursors((current) => [...current, nextCursor])
                }
              >
                {t("common.next")}
              </Button>
            </div>
          </footer>
        </DataTableShell>
      )}
    </div>
  );
}
