// Supervisor queue of shift, leave and overtime requests (bead legend-ydf2,
// mockups queue-*.png). Desktop shows a table, mobile cards. The decision
// happens on the detail page. States: loading, empty, error, offline.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRequestQueue } from "@/features/hris-requests/hooks";
import { useOnline } from "@/lib/use-online";
import type { RequestQueueItem } from "../queue.ts";
import { QueueKindPill, useKindLabel } from "./queue-kind-pill.tsx";
import { filterQueue } from "./queue-model.ts";
import { QueueOfflineBanner } from "./queue-offline-banner.tsx";
import { QueueStatusPill } from "./queue-status-pill.tsx";

export function QueuePage() {
  const t = useT();
  const online = useOnline();
  const query = useRequestQueue({ status: "pending" });
  const [search, setSearch] = React.useState("");

  const items = React.useMemo(() => query.data ?? [], [query.data]);
  const filtered = React.useMemo(
    () => filterQueue(items, search),
    [items, search],
  );
  const unknownEmployee = t("hrisRequestsQueue.detail.unknownEmployee");

  const failed = query.isError && query.data === undefined;
  const state: DataState = query.isPending
    ? "loading"
    : failed
      ? "ready"
      : items.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-5">
      <div className="grid min-w-0 gap-1">
        <h2 className="type-title">{t("hrisRequestsQueue.page.title")}</h2>
        <p className="text-muted-foreground">
          {t("hrisRequestsQueue.page.description")}
        </p>
      </div>

      {!online && <QueueOfflineBanner />}

      <DataTableShell
        title={t("hrisRequestsQueue.queue.sectionTitle")}
        state={state}
        bare
        search={
          failed
            ? undefined
            : {
                value: search,
                onChange: setSearch,
                label: t("hrisRequestsQueue.queue.searchLabel"),
                placeholder: t("hrisRequestsQueue.queue.searchPlaceholder"),
              }
        }
        empty={{
          title: t("hrisRequestsQueue.empty.title"),
          description: t("hrisRequestsQueue.empty.description"),
        }}
        noResults={!failed && items.length > 0 && filtered.length === 0}
        rowCount={failed ? undefined : filtered.length}
        loadingRows={4}
      >
        {failed ? (
          <ErrorState
            title={t("hrisRequestsQueue.error.title")}
            description={t("hrisRequestsQueue.error.description")}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <QueueTable items={filtered} unknownEmployee={unknownEmployee} />
            </div>
            <ul
              className="grid divide-y md:hidden"
              aria-label={t("hrisRequestsQueue.queue.tableLabel")}
            >
              {filtered.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  <QueueCard item={item} unknownEmployee={unknownEmployee} />
                </li>
              ))}
            </ul>
            <p className="border-t px-4 py-3 text-sm text-muted-foreground">
              {t("hrisRequestsQueue.queue.count", { count: filtered.length })}
            </p>
          </>
        )}
      </DataTableShell>
    </div>
  );
}

function ReviewLink({
  item,
  employee,
  className,
}: {
  item: RequestQueueItem;
  employee: string;
  className?: string;
}) {
  const t = useT();
  const kind = useKindLabel()(item);
  return (
    <Button asChild variant="outline" className={className}>
      <Link
        to="/kelola/pengajuan/$kind/$requestId"
        params={{ kind: item.kind, requestId: item.id }}
        aria-label={t("hrisRequestsQueue.queue.reviewFor", { kind, employee })}
      >
        {t("hrisRequestsQueue.queue.review")}
      </Link>
    </Button>
  );
}

function QueueTable({
  items,
  unknownEmployee,
}: {
  items: readonly RequestQueueItem[];
  unknownEmployee: string;
}) {
  const t = useT();
  return (
    <Table aria-label={t("hrisRequestsQueue.queue.tableLabel")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("hrisRequestsQueue.queue.columnKind")}</TableHead>
          <TableHead>{t("hrisRequestsQueue.queue.columnEmployee")}</TableHead>
          <TableHead>{t("hrisRequestsQueue.queue.columnDetail")}</TableHead>
          <TableHead>{t("hrisRequestsQueue.queue.columnStatus")}</TableHead>
          <TableHead>{t("hrisRequestsQueue.queue.columnAction")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const employee = item.employeeName ?? unknownEmployee;
          return (
            <TableRow key={`${item.kind}:${item.id}`}>
              <TableCell>
                <QueueKindPill item={item} />
              </TableCell>
              <TableCell className="font-medium">{employee}</TableCell>
              <TableCell className="tabular">{item.period}</TableCell>
              <TableCell>
                <QueueStatusPill status={item.status} />
              </TableCell>
              <TableCell className="w-px pr-card whitespace-nowrap">
                <ReviewLink item={item} employee={employee} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function QueueCard({
  item,
  unknownEmployee,
}: {
  item: RequestQueueItem;
  unknownEmployee: string;
}) {
  const employee = item.employeeName ?? unknownEmployee;
  return (
    <article className="grid gap-3 p-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <QueueKindPill item={item} />
        <h3 className="text-base leading-6 font-semibold">{employee}</h3>
      </div>
      <p className="tabular">{item.period}</p>
      <QueueStatusPill status={item.status} />
      <ReviewLink item={item} employee={employee} className="min-h-11 w-full" />
    </article>
  );
}
