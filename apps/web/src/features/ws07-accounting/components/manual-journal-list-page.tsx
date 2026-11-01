// Manual journals list (PRD v1.7 §3.19 "Jurnal Manual & Berulang [P0] —
// Jurnal umum, penyesuaian, dan jurnal berulang dengan approval"). Status is
// the workflow: draft → pending_approval → posted (or rejected/cancelled),
// decided by someone other than the requester (AUTH-06).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import type { ManualJournalStatus } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { FormField } from "@/components/ui/form-field";
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
import { useManualJournalsInfinite } from "../hooks";
import {
  JOURNAL_STATUS_KEYS,
  MANUAL_KIND_KEYS,
  formatBusinessDate,
  linesTotal,
} from "../lib";
import { ManualJournalStatusBadge } from "./status-badge";

const ALL = "all";
const STATUSES = Object.keys(JOURNAL_STATUS_KEYS) as ManualJournalStatus[];

export function ManualJournalListPage({
  legalEntityId,
}: {
  legalEntityId: string;
}) {
  const t = useT();
  const [status, setStatus] = React.useState<string>(ALL);
  const list = useManualJournalsInfinite({
    legalEntityId,
    ...(status === ALL ? {} : { status: status as ManualJournalStatus }),
  });

  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];
  const state: DataState = list.isPending
    ? "loading"
    : list.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  const newButton = (
    <Button asChild size="sm">
      <Link to="/kelola/akuntansi/jurnal-manual/baru">
        <Plus aria-hidden="true" />
        {t("accounting.manual.new")}
      </Link>
    </Button>
  );

  return (
    <div className="grid min-w-0 gap-4">
      <section
        aria-label={t("accounting.manual.filterStatus")}
        className="grid gap-3 rounded-xl border-(length:--border-w) border-border bg-card p-card sm:grid-cols-2 lg:grid-cols-4"
      >
        <FormField label={t("accounting.manual.filterStatus")}>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-control-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("accounting.manual.statusAll")}
              </SelectItem>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(JOURNAL_STATUS_KEYS[value])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </section>
      <DataTableShell
        title={t("accounting.manual.title")}
        description={t("accounting.manual.subtitle")}
        state={state}
        onRetry={() => {
          void list.refetch();
        }}
        actions={state === "empty" ? undefined : newButton}
        empty={{
          title: t("accounting.manual.emptyTitle"),
          description: t("accounting.manual.emptyHint"),
          action: newButton,
        }}
      >
        {/* Phones: one row per journal with its workflow status. */}
        <ul className="divide-y divide-border md:hidden">
          {rows.map((journal) => (
            <li key={journal.id}>
              <Link
                to="/kelola/akuntansi/jurnal-manual/$manualJournalId"
                params={{ manualJournalId: journal.id }}
                className="grid gap-1 p-card transition-colors duration-(--duration-fast) hover:bg-accent/60"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm tabular text-muted-foreground">
                    {formatBusinessDate(journal.entryDate)}
                  </span>
                  <ManualJournalStatusBadge status={journal.status} />
                </span>
                <span className="font-medium">{journal.description}</span>
                <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>{t(MANUAL_KIND_KEYS[journal.kind])}</span>
                  <Money amount={linesTotal(journal.lines)} size="sm" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[40rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounting.manual.columns.date")}</TableHead>
                <TableHead>
                  {t("accounting.manual.columns.description")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("accounting.manual.columns.kind")}
                </TableHead>
                <TableHead>{t("accounting.manual.columns.status")}</TableHead>
                <TableHead numeric>
                  {t("accounting.manual.columns.total")}
                </TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("accounting.manual.open")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((journal) => (
                <TableRow key={journal.id}>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatBusinessDate(journal.entryDate)}
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/kelola/akuntansi/jurnal-manual/$manualJournalId"
                      params={{ manualJournalId: journal.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {journal.description}
                    </Link>
                    <span className="block text-sm text-muted-foreground md:hidden">
                      {t(MANUAL_KIND_KEYS[journal.kind])}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {t(MANUAL_KIND_KEYS[journal.kind])}
                  </TableCell>
                  <TableCell>
                    <ManualJournalStatusBadge status={journal.status} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={linesTotal(journal.lines)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link
                        to="/kelola/akuntansi/jurnal-manual/$manualJournalId"
                        params={{ manualJournalId: journal.id }}
                        aria-label={`${t("accounting.manual.open")} ${journal.description}`}
                      >
                        <ChevronRight aria-hidden="true" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-card">
          <span className="text-sm tabular text-muted-foreground">
            {t("accounting.journals.count", { count: rows.length })}
          </span>
          {list.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={list.isFetchingNextPage}
              onClick={() => {
                void list.fetchNextPage();
              }}
            >
              {t("accounting.journals.loadMore")}
            </Button>
          )}
        </div>
      </DataTableShell>
    </div>
  );
}
