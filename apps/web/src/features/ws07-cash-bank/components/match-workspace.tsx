// Match workspace (PRD §3.19 "Kas & Bank": matching statement lines with
// journals/deposits; ACC-04 ≥99% auto-match and every difference becomes a
// case with a PIC). The suggestion is the contract's deterministic matcher
// (findStatementMatch) over the account's journal bank lines and deposits, not
// an AI guess: one candidate = one-click match, several = the person chooses.
import * as React from "react";
import { Ban, FolderOpen, Link2, Undo2 } from "lucide-react";
import { DEFAULT_FINANCE_POLICY } from "@starter/shared/accounting";
import type {
  BankAccount,
  BankStatementLine,
  MatchStatus,
  ReconciliationRef,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Input } from "@/components/ui/input";
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
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { ConfirmDialog } from "@/features/ws07-accounting/components/confirm-dialog";
import { ReasonDialog } from "@/features/ws07-accounting/components/reason-dialog";
import {
  MATCH_STATUS_KEYS,
  REF_TYPE_KEYS,
  businessDateToday,
  candidateKey,
  formatBusinessDate,
  matchCandidates,
  matchErrorKey,
  monthRange,
  occupiedRefs,
  shortId,
  suggestMatch,
  type MatchOutcome,
} from "../lib";
import {
  useCashDeposits,
  useExcludeStatementLine,
  useFinancePolicy,
  useMatchJournals,
  useMatchStatementLine,
  useStatementLinesForPeriod,
  useStatementLinesInfinite,
  useUnmatchStatementLine,
} from "../hooks";
import { MatchStatusBadge } from "./status-badges";
import { OpenCaseDialog } from "./open-case-dialog";

const ALL = "all";

const STATUS_FILTERS: readonly (MatchStatus | "all")[] = [
  "all",
  "unmatched",
  "auto_matched",
  "manually_matched",
  "in_case",
  "excluded",
];

export function MatchWorkspace({
  legalEntityId,
  accounts,
  account,
  onAccountChange,
  canWrite,
  onImport,
  onAddAccount,
}: {
  legalEntityId: string;
  accounts: readonly BankAccount[];
  account: BankAccount | undefined;
  onAccountChange: (bankAccountId: string) => void;
  canWrite: boolean;
  onImport: () => void;
  onAddAccount: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const today = businessDateToday();
  const [range, setRange] = React.useState(() => monthRange(today));
  const [statusFilter, setStatusFilter] = React.useState<MatchStatus | "all">(
    ALL,
  );
  const [excludeLine, setExcludeLine] =
    React.useState<BankStatementLine | null>(null);
  const [unmatchLine, setUnmatchLine] =
    React.useState<BankStatementLine | null>(null);
  const [restoreLine, setRestoreLine] =
    React.useState<BankStatementLine | null>(null);
  const [caseLine, setCaseLine] = React.useState<BankStatementLine | null>(
    null,
  );
  const [chosenRef, setChosenRef] = React.useState<Record<string, string>>({});
  const [actionError, setActionError] = React.useState<ReturnType<
    typeof matchErrorKey
  > | null>(null);

  const lines = useStatementLinesInfinite({
    bankAccountId: account?.id ?? "",
    from: range.from,
    to: range.to,
    matchStatus: statusFilter,
  });
  const periodLines = useStatementLinesForPeriod(
    account?.id,
    range.from,
    range.to,
  );
  const journals = useMatchJournals(legalEntityId, range.from, range.to);
  const deposits = useCashDeposits(legalEntityId, range.from, range.to);
  const match = useMatchStatementLine();
  const financePolicy = useFinancePolicy();
  const exclude = useExcludeStatementLine();
  const unmatch = useUnmatchStatementLine();

  const rows = lines.data?.pages.flatMap((page) => page.data) ?? [];
  const candidates = React.useMemo(() => {
    if (!account) return [];
    return matchCandidates(
      journals.data ?? [],
      deposits.data?.data ?? [],
      account.id,
      account.glAccountId,
      occupiedRefs(periodLines.data?.data ?? []),
    );
  }, [account, journals.data, deposits.data, periodLines.data]);

  const state: DataState = !account
    ? "empty"
    : lines.isPending
      ? "loading"
      : lines.isError
        ? "error"
        : rows.length === 0
          ? "empty"
          : "ready";

  const reportError = (error: unknown) => {
    setActionError(
      error instanceof ApiError
        ? matchErrorKey(error.code)
        : "accounting.cash.match.error.failed",
    );
  };

  const runMatch = (line: BankStatementLine, ref: ReconciliationRef) => {
    setActionError(null);
    match.mutate(
      { lineId: line.id, refs: [ref] },
      {
        onSuccess: () =>
          toast({
            title: t("accounting.cash.match.matchDone"),
            tone: "success",
          }),
        onError: reportError,
      },
    );
  };

  const candidateDate = (ref: ReconciliationRef): string => {
    const hit = candidates.find(
      (candidate) => candidateKey(candidate.ref) === candidateKey(ref),
    );
    return hit ? formatBusinessDate(hit.date) : shortId(ref.id);
  };

  const suggestionOf = (line: BankStatementLine): MatchOutcome =>
    suggestMatch(
      line,
      candidates,
      (financePolicy.data ?? DEFAULT_FINANCE_POLICY).matchingPolicy,
    );

  const renderSuggestion = (line: BankStatementLine) => {
    const outcome = suggestionOf(line);
    if (outcome.kind === "auto")
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t("accounting.cash.match.suggestion.auto", {
              ref: t(REF_TYPE_KEYS[outcome.ref.type]),
              date: candidateDate(outcome.ref),
            })}
          </span>
          <Button
            type="button"
            size="sm"
            loading={match.isPending}
            onClick={() => runMatch(line, outcome.ref)}
          >
            <Link2 aria-hidden="true" />
            {t("accounting.cash.match.suggestion.match")}
          </Button>
        </span>
      );
    if (outcome.kind === "ambiguous") {
      const chosen = chosenRef[line.id] ?? candidateKey(outcome.refs[0]!);
      const selected =
        outcome.refs.find((ref) => candidateKey(ref) === chosen) ??
        outcome.refs[0]!;
      return (
        <span className="flex flex-wrap items-center gap-2">
          <Select
            value={chosen}
            onValueChange={(value) =>
              setChosenRef((current) => ({ ...current, [line.id]: value }))
            }
          >
            <SelectTrigger
              className="h-control-sm w-48"
              aria-label={t("accounting.cash.match.suggestion.choose")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {outcome.refs.map((ref) => (
                <SelectItem key={candidateKey(ref)} value={candidateKey(ref)}>
                  {`${t(REF_TYPE_KEYS[ref.type])} · ${candidateDate(ref)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            loading={match.isPending}
            onClick={() => runMatch(line, selected)}
          >
            <Link2 aria-hidden="true" />
            {t("accounting.cash.match.suggestion.match")}
          </Button>
        </span>
      );
    }
    return (
      <span className="text-sm text-muted-foreground">
        {t("accounting.cash.match.suggestion.none")}
      </span>
    );
  };

  const actionsFor = (line: BankStatementLine) => {
    if (!canWrite) return null;
    if (
      line.matchStatus === "auto_matched" ||
      line.matchStatus === "manually_matched"
    )
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setUnmatchLine(line)}
        >
          <Undo2 aria-hidden="true" />
          {t("accounting.cash.match.actions.unmatch")}
        </Button>
      );
    if (line.matchStatus === "excluded")
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRestoreLine(line)}
        >
          <Undo2 aria-hidden="true" />
          {t("accounting.cash.match.actions.restore")}
        </Button>
      );
    if (line.matchStatus === "in_case") return null;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExcludeLine(line)}
        >
          <Ban aria-hidden="true" />
          {t("accounting.cash.match.actions.exclude")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCaseLine(line)}
        >
          <FolderOpen aria-hidden="true" />
          {t("accounting.cash.match.actions.case")}
        </Button>
      </div>
    );
  };

  return (
    <>
      <DataTableShell
        title={t("accounting.cash.match.title")}
        description={t("accounting.cash.match.subtitle")}
        state={state}
        onRetry={() => {
          void lines.refetch();
        }}
        rowCount={rows.length}
        actions={
          account && canWrite ? (
            <Button type="button" size="sm" onClick={onImport}>
              {t("accounting.cash.import.action")}
            </Button>
          ) : undefined
        }
        empty={{
          title: account
            ? t("accounting.cash.match.emptyTitle")
            : t("accounting.cash.match.noAccountTitle"),
          description: account
            ? t("accounting.cash.match.emptyHint")
            : t("accounting.cash.match.noAccountHint"),
          action:
            !account && canWrite ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onAddAccount}
              >
                {t("accounting.cash.accounts.add")}
              </Button>
            ) : undefined,
        }}
      >
        <div
          id="cash-match"
          className="grid gap-3 border-b border-border px-card py-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {account && (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">
                {t("accounting.cash.match.account")}
              </span>
              <Select value={account.id} onValueChange={onAccountChange}>
                <SelectTrigger
                  className="h-control-sm"
                  aria-label={t("accounting.cash.match.account")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {`${row.bank} · ${row.accountNumberMasked}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">
              {t("accounting.cash.match.from")}
            </span>
            <Input
              type="date"
              value={range.from}
              max={range.to}
              className="tabular"
              aria-label={t("accounting.cash.match.from")}
              onChange={(event) =>
                setRange((current) => ({
                  from: event.target.value,
                  to:
                    event.target.value > current.to
                      ? event.target.value
                      : current.to,
                }))
              }
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">
              {t("accounting.cash.match.to")}
            </span>
            <Input
              type="date"
              value={range.to}
              min={range.from}
              className="tabular"
              aria-label={t("accounting.cash.match.to")}
              onChange={(event) =>
                setRange((current) => ({
                  from:
                    event.target.value < current.from
                      ? event.target.value
                      : current.from,
                  to: event.target.value,
                }))
              }
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">
              {t("accounting.cash.match.statusFilter")}
            </span>
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as MatchStatus | "all")
              }
            >
              <SelectTrigger
                className="h-control-sm"
                aria-label={t("accounting.cash.match.statusFilter")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status === "all"
                      ? t("accounting.cash.match.allStatuses")
                      : t(MATCH_STATUS_KEYS[status])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {actionError && (
          <p
            role="alert"
            className="border-b border-border px-card py-2 text-sm leading-5 font-medium text-danger"
          >
            {t(actionError)}
          </p>
        )}
        <Table className="min-w-[56rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("accounting.cash.match.columns.date")}</TableHead>
              <TableHead>
                {t("accounting.cash.match.columns.description")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.cash.match.columns.amount")}
              </TableHead>
              <TableHead>{t("accounting.cash.match.columns.status")}</TableHead>
              <TableHead>
                {t("accounting.cash.match.columns.suggestion")}
              </TableHead>
              <TableHead className="text-right">
                {t("accounting.cash.match.columns.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="whitespace-nowrap tabular">
                  {formatBusinessDate(line.postedOn)}
                </TableCell>
                <TableCell className="max-w-72">
                  <span className="block truncate font-medium">
                    {line.description}
                  </span>
                  {line.externalRef && (
                    <span className="block text-sm tabular text-muted-foreground">
                      {line.externalRef}
                    </span>
                  )}
                  {line.matchStatus === "excluded" && line.excludedReason && (
                    <span className="block text-sm text-muted-foreground">
                      {line.excludedReason}
                    </span>
                  )}
                </TableCell>
                <TableCell numeric>
                  <Money amount={line.amountIdr} />
                </TableCell>
                <TableCell>
                  <MatchStatusBadge status={line.matchStatus} />
                  {line.matchedRefs.length > 0 && (
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {t("accounting.cash.match.actions.matchedRefs")}:{" "}
                      {line.matchedRefs
                        .map(
                          (ref) =>
                            `${t(REF_TYPE_KEYS[ref.type])} ${shortId(ref.id)}`,
                        )
                        .join(", ")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-72">
                  {line.matchStatus === "unmatched"
                    ? renderSuggestion(line)
                    : null}
                </TableCell>
                <TableCell className="text-right">{actionsFor(line)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-card py-2.5">
          <span className="text-sm tabular text-muted-foreground">
            {t("accounting.cash.match.count", { count: rows.length })}
          </span>
          {lines.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={lines.isFetchingNextPage}
              onClick={() => {
                void lines.fetchNextPage();
              }}
            >
              {t("accounting.cash.match.loadMore")}
            </Button>
          )}
        </div>
      </DataTableShell>

      <ReasonDialog
        open={excludeLine !== null}
        onOpenChange={(open) => {
          if (!open) setExcludeLine(null);
        }}
        title={t("accounting.cash.match.exclude.title")}
        label={t("accounting.cash.match.exclude.label")}
        hint={t("accounting.cash.match.exclude.description")}
        submitLabel={t("accounting.cash.match.exclude.submit")}
        pending={exclude.isPending}
        onSubmit={(reason) => {
          if (!excludeLine) return;
          setActionError(null);
          exclude.mutate(
            { lineId: excludeLine.id, reason },
            {
              onSuccess: () => {
                toast({
                  title: t("accounting.cash.match.exclude.done"),
                  tone: "success",
                });
                setExcludeLine(null);
              },
              onError: reportError,
            },
          );
        }}
      />

      <ConfirmDialog
        open={unmatchLine !== null}
        onOpenChange={(open) => {
          if (!open) setUnmatchLine(null);
        }}
        title={t("accounting.cash.match.unmatch.title")}
        description={t("accounting.cash.match.unmatch.description")}
        confirmLabel={t("accounting.cash.match.unmatch.submit")}
        destructive={false}
        pending={unmatch.isPending}
        onConfirm={() => {
          if (!unmatchLine) return;
          setActionError(null);
          unmatch.mutate(unmatchLine.id, {
            onSuccess: () => {
              toast({
                title: t("accounting.cash.match.unmatch.done"),
                tone: "success",
              });
              setUnmatchLine(null);
            },
            onError: reportError,
          });
        }}
      />

      <ConfirmDialog
        open={restoreLine !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreLine(null);
        }}
        title={t("accounting.cash.match.restore.title")}
        description={t("accounting.cash.match.restore.description")}
        confirmLabel={t("accounting.cash.match.actions.restore")}
        destructive={false}
        pending={unmatch.isPending}
        onConfirm={() => {
          if (!restoreLine) return;
          setActionError(null);
          unmatch.mutate(restoreLine.id, {
            onSuccess: () => {
              toast({
                title: t("accounting.cash.match.restore.done"),
                tone: "success",
              });
              setRestoreLine(null);
            },
            onError: reportError,
          });
        }}
      />

      {caseLine && (
        <OpenCaseDialog
          open={caseLine !== null}
          onOpenChange={(open) => {
            if (!open) setCaseLine(null);
          }}
          legalEntityId={legalEntityId}
          type="bank_statement"
          differenceIdr={caseLine.amountIdr}
          refs={[{ type: "bank_statement_line", id: caseLine.id }]}
          description={caseLine.description}
        />
      )}
    </>
  );
}
