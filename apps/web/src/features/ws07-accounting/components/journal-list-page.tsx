// Posted journals list (PRD v1.7 §3.19 "Jurnal Otomatis"; ACC-01 final
// entries, ACC-03 drill-down). Filters narrow by period, source and account;
// each row links into the detail screen where the source document is one step
// away.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { JournalSourceType } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money, NumberDisplay } from "@/components/ui/money";
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
import { useAccounts, useJournalsInfinite } from "../hooks";
import {
  JOURNAL_SOURCE_KEYS,
  businessDateToday,
  formatBusinessDate,
  monthRange,
  postableAccounts,
} from "../lib";

const ALL = "all";
const SOURCE_TYPES = Object.keys(JOURNAL_SOURCE_KEYS) as JournalSourceType[];

export function JournalListPage({ legalEntityId }: { legalEntityId: string }) {
  const t = useT();
  const today = businessDateToday();
  const [range, setRange] = React.useState(() => monthRange(today));
  const [sourceType, setSourceType] = React.useState<string>(ALL);
  const [accountId, setAccountId] = React.useState<string>(ALL);
  const accountsQuery = useAccounts(legalEntityId);

  const journals = useJournalsInfinite({
    legalEntityId,
    from: range.from,
    to: range.to,
    ...(sourceType === ALL
      ? {}
      : { sourceType: sourceType as JournalSourceType }),
    ...(accountId === ALL ? {} : { accountId }),
  });

  const rows = journals.data?.pages.flatMap((page) => page.data) ?? [];
  const state: DataState = journals.isPending
    ? "loading"
    : journals.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";
  const accounts = postableAccounts(accountsQuery.data ?? []);

  return (
    <div className="grid min-w-0 gap-4">
      <section
        aria-label={t("accounting.journals.title")}
        className="grid gap-3 rounded-xl border-(length:--border-w) border-border bg-card p-card sm:grid-cols-2 lg:grid-cols-4"
      >
        <FormField label={t("accounting.journals.from")} required>
          <Input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(event) =>
              setRange((current) => ({
                from: event.target.value,
                to:
                  event.target.value > current.to
                    ? event.target.value
                    : current.to,
              }))
            }
            className="tabular"
          />
        </FormField>
        <FormField label={t("accounting.journals.to")} required>
          <Input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(event) =>
              setRange((current) => ({
                from:
                  event.target.value < current.from
                    ? event.target.value
                    : current.from,
                to: event.target.value,
              }))
            }
            className="tabular"
          />
        </FormField>
        <FormField label={t("accounting.journals.source")}>
          <Select value={sourceType} onValueChange={setSourceType}>
            <SelectTrigger className="h-control-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("accounting.journals.sourceAll")}
              </SelectItem>
              {SOURCE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(JOURNAL_SOURCE_KEYS[type])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t("accounting.journals.account")}>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="h-control-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t("accounting.journals.accountAll")}
              </SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </section>
      <DataTableShell
        title={t("accounting.journals.title")}
        description={t("accounting.journals.subtitle")}
        state={state}
        onRetry={() => {
          void journals.refetch();
        }}
        empty={{
          title: t("accounting.journals.emptyTitle"),
          description: t("accounting.journals.emptyHint"),
        }}
      >
        {/* Phones: one row per journal; the whole row is the link. */}
        <ul className="divide-y divide-border md:hidden">
          {rows.map((entry) => (
            <li key={entry.id}>
              <Link
                to="/kelola/akuntansi/jurnal/$journalEntryId"
                params={{ journalEntryId: entry.id }}
                className="grid gap-1 p-card transition-colors duration-(--duration-fast) hover:bg-accent/60"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm tabular text-muted-foreground">
                    {formatBusinessDate(entry.entryDate)}
                  </span>
                  {entry.reversedBy && (
                    <Badge tone="warning">
                      {t("accounting.journals.reversed")}
                    </Badge>
                  )}
                </span>
                <span className="font-medium">{entry.description}</span>
                <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>{t(JOURNAL_SOURCE_KEYS[entry.sourceType])}</span>
                  <Money amount={entry.totalIdr} size="sm" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounting.journals.columns.date")}</TableHead>
                <TableHead>
                  {t("accounting.journals.columns.description")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("accounting.journals.columns.source")}
                </TableHead>
                <TableHead numeric className="hidden sm:table-cell">
                  {t("accounting.journals.columns.lines")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.journals.columns.total")}
                </TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("accounting.manual.open")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatBusinessDate(entry.entryDate)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        to="/kelola/akuntansi/jurnal/$journalEntryId"
                        params={{ journalEntryId: entry.id }}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {entry.description}
                      </Link>
                      {entry.reversedBy && (
                        <Badge tone="warning">
                          {t("accounting.journals.reversed")}
                        </Badge>
                      )}
                    </div>
                    <span className="block pt-1 text-sm text-muted-foreground lg:hidden">
                      {t(JOURNAL_SOURCE_KEYS[entry.sourceType])}
                    </span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {t(JOURNAL_SOURCE_KEYS[entry.sourceType])}
                  </TableCell>
                  <TableCell numeric className="hidden sm:table-cell">
                    <NumberDisplay value={entry.lineCount} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={entry.totalIdr} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link
                        to="/kelola/akuntansi/jurnal/$journalEntryId"
                        params={{ journalEntryId: entry.id }}
                        aria-label={`${t("accounting.manual.open")} ${entry.description}`}
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
          {journals.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={journals.isFetchingNextPage}
              onClick={() => {
                void journals.fetchNextPage();
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
