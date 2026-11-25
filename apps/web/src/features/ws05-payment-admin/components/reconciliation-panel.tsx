// Settlement reconciliation (EDC-06): transactions, MDR fees and the money
// that reached the bank account are matched automatically; every difference
// becomes a case and is closed with a written note. Gateway and EDC batches
// (per bank) live in the same queue.
import * as React from "react";
import { useRetainedAttempt } from "../../../lib/use-retained-attempt.ts";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PendingDialog,
  PendingDialogContent,
} from "@/components/ui/pending-dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type {
  ReconciliationCaseView,
  ReconciliationSource,
} from "@starter/shared/payment/admin";
import {
  bankLabelKey,
  filterReconciliationCases,
  formatMoment,
  reconciliationLabelKey,
  reconciliationTone,
} from "../format";
import {
  useReconciliationCases,
  useReconciliationSummary,
  useResolveReconciliationCase,
} from "../hooks";

const ALL = "all";

function sourceLabel(
  source: ReconciliationSource,
  provider: string,
  t: ReturnType<typeof useT>,
): string {
  if (source === "gateway")
    return t("paymentAdmin.reconciliation.sourceGateway");
  const bank = provider.replace("edc_", "");
  return `${t("paymentAdmin.reconciliation.sourceEdc")} · ${
    bank === "bca" || bank === "mandiri" || bank === "bni" || bank === "bjb"
      ? t(bankLabelKey(bank))
      : bank.toUpperCase()
  }`;
}

export function ReconciliationPanel() {
  const t = useT();
  const summary = useReconciliationSummary();
  const cases = useReconciliationCases();
  const [status, setStatus] = React.useState<
    ReconciliationCaseView["status"] | "all"
  >(ALL);
  const [source, setSource] = React.useState<ReconciliationSource | "all">(ALL);
  const [resolving, setResolving] =
    React.useState<ReconciliationCaseView | null>(null);
  const all = cases.data?.data ?? [];
  const rows = filterReconciliationCases(all, { status, source });
  const state = cases.isPending
    ? "loading"
    : cases.isError
      ? "error"
      : all.length === 0
        ? "empty"
        : "ready";

  return (
    <section
      aria-labelledby="reconciliation-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <div className="grid gap-1">
        <h2 id="reconciliation-title" className="type-title">
          {t("paymentAdmin.reconciliation.title")}
        </h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("paymentAdmin.reconciliation.hint")}
        </p>
      </div>

      {summary.isPending ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
          <Skeleton className="h-24 sm:col-span-2 lg:col-span-4" />
        </div>
      ) : summary.error instanceof ApiError && summary.error.status === 503 ? (
        // The API fails closed until settlement import exists (legend-jlqi):
        // say so plainly instead of offering a retry that cannot succeed.
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <EmptyState
            title={t("paymentAdmin.reconciliation.summaryUnavailableTitle")}
            description={t(
              "paymentAdmin.reconciliation.summaryUnavailableHint",
            )}
          />
        </div>
      ) : summary.isError ? (
        <div className="rounded-container border-(length:--border-w) bg-card">
          <ErrorState
            title={t("paymentAdmin.loadErrorTitle")}
            description={t("paymentAdmin.loadErrorHint")}
            onRetry={() => void summary.refetch()}
          />
        </div>
      ) : (
        // Owner Q30 (DESIGN.md v2): related metrics share one strip with
        // hairline dividers instead of separate cards.
        <StatStrip
          label={t("paymentAdmin.reconciliation.summaryLabel")}
          columns={4}
        >
          <StatTile
            label={t("paymentAdmin.reconciliation.matched")}
            value={summary.data.data.matchedLines}
          />
          <StatTile
            label={t("paymentAdmin.reconciliation.unmatched")}
            value={summary.data.data.unmatchedLines}
          />
          <StatTile
            label={t("paymentAdmin.reconciliation.mismatch")}
            value={summary.data.data.mismatchLines}
          />
          <StatTile
            label={t("paymentAdmin.reconciliation.openCases")}
            value={summary.data.data.openCases}
          />
          <StatTile
            className="lg:col-span-4"
            label={t("paymentAdmin.reconciliation.variance")}
            // One source link for the strip (accent budget Q21): every count
            // comes from the cases table just below.
            value={<Money amount={summary.data.data.varianceIdr} />}
            source={
              <a href="#reconciliation-cases">
                {t("paymentAdmin.reconciliation.casesTitle")}
              </a>
            }
          />
        </StatStrip>
      )}

      <div id="reconciliation-cases" className="min-w-0">
        <DataTableShell
          title={t("paymentAdmin.reconciliation.casesTitle")}
          state={state}
          rowCount={rows.length}
          noResults={all.length > 0 && rows.length === 0}
          onRetry={() => void cases.refetch()}
          actions={
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={status}
                onValueChange={(value) =>
                  setStatus(value as ReconciliationCaseView["status"] | "all")
                }
              >
                <SelectTrigger
                  className="w-full sm:w-40"
                  aria-label={t("paymentAdmin.reconciliation.filter")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("paymentAdmin.reconciliation.allStatuses")}
                  </SelectItem>
                  <SelectItem value="open">
                    {t("paymentAdmin.reconciliation.statusOpen")}
                  </SelectItem>
                  <SelectItem value="pending_approval">
                    {t("paymentAdmin.reconciliation.statusPending")}
                  </SelectItem>
                  <SelectItem value="resolved">
                    {t("paymentAdmin.reconciliation.statusResolved")}
                  </SelectItem>
                  <SelectItem value="matched">
                    {t("paymentAdmin.reconciliation.statusMatched")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={source}
                onValueChange={(value) =>
                  setSource(value as ReconciliationSource | "all")
                }
              >
                <SelectTrigger
                  className="w-full sm:w-44"
                  aria-label={t("paymentAdmin.reconciliation.filterSource")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("paymentAdmin.reconciliation.allSources")}
                  </SelectItem>
                  <SelectItem value="gateway">
                    {t("paymentAdmin.reconciliation.sourceGateway")}
                  </SelectItem>
                  <SelectItem value="edc">
                    {t("paymentAdmin.reconciliation.sourceEdc")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          }
          empty={{
            title: t("paymentAdmin.reconciliation.emptyTitle"),
            description: t("paymentAdmin.reconciliation.emptyHint"),
          }}
        >
          <ul className="divide-y divide-border">
            {rows.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-3 p-card lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="grid min-w-0 gap-0.5">
                  <p className="font-semibold">{entry.reference}</p>
                  <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge tone={entry.source === "edc" ? "info" : "neutral"}>
                      {sourceLabel(entry.source, entry.provider, t)}
                    </Badge>
                    <span>
                      {entry.periodStart === entry.periodEnd
                        ? entry.periodStart
                        : `${entry.periodStart} – ${entry.periodEnd}`}{" "}
                      · {formatMoment(entry.createdAt)}
                    </span>
                  </p>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    {entry.reason}
                  </p>
                  {entry.status === "pending_approval" &&
                    entry.requestedByName && (
                      <p className="text-sm text-muted-foreground">
                        {t("paymentAdmin.reconciliation.requestedBy", {
                          name: entry.requestedByName,
                        })}
                        {entry.note ? ` · ${entry.note}` : ""}
                      </p>
                    )}
                  {entry.status === "resolved" && entry.resolvedByName && (
                    <p className="text-sm text-muted-foreground">
                      {entry.resolvedByName}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </p>
                  )}
                  {entry.status === "resolved" && entry.approvedByName && (
                    <p className="text-sm text-muted-foreground">
                      {t("paymentAdmin.reconciliation.approvedBy", {
                        name: entry.approvedByName,
                      })}
                    </p>
                  )}
                  {entry.approvalRequestId && (
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {t("paymentAdmin.reconciliation.approvalRef", {
                        id: entry.approvalRequestId,
                      })}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                  <div className="text-sm text-muted-foreground">
                    <p>
                      {t("paymentAdmin.reconciliation.expected")}{" "}
                      <Money amount={entry.expectedIdr} size="sm" />
                    </p>
                    <p>
                      {t("paymentAdmin.reconciliation.received")}{" "}
                      <Money amount={entry.receivedIdr} size="sm" />
                    </p>
                  </div>
                  <div className="text-right">
                    <Money amount={entry.varianceIdr} size="lg" />
                    <p className="text-sm text-muted-foreground">
                      {t("paymentAdmin.reconciliation.varianceColumn")}
                    </p>
                  </div>
                  <StatusPill status={reconciliationTone(entry.status)}>
                    {t(reconciliationLabelKey(entry.status))}
                  </StatusPill>
                  {entry.status === "open" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setResolving(entry)}
                    >
                      {t("paymentAdmin.reconciliation.resolve")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </DataTableShell>
      </div>

      {resolving && (
        <ResolveCaseDialog
          entry={resolving}
          onClose={() => setResolving(null)}
        />
      )}
    </section>
  );
}

function ResolveCaseDialog({
  entry,
  onClose,
}: {
  entry: ReconciliationCaseView;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const resolve = useResolveReconciliationCase();
  const attempt = useRetainedAttempt(`recon.resolve.${entry.id}`);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (note.trim().length < 4) {
      setError(t("paymentAdmin.reconciliation.noteRequired"));
      return;
    }
    const input = { caseId: entry.id, body: { note: note.trim() } };
    resolve.mutate(
      { ...input, idempotencyKey: attempt.keyFor(input) },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("paymentAdmin.reconciliation.resolved", {
              reference: entry.reference,
            }),
          });
          onClose();
        },
        onError: (mutationError) => setError(mutationError.message),
      },
    );
  };

  return (
    <PendingDialog
      pending={resolve.isPending}
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("paymentAdmin.reconciliation.resolveTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("paymentAdmin.reconciliation.resolveBody", {
              reference: entry.reference,
            })}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-1 rounded-lg bg-muted p-card">
            <p className="text-sm text-muted-foreground">
              {t("paymentAdmin.reconciliation.varianceColumn")}
            </p>
            <p className="text-xl font-semibold">
              <Money amount={entry.varianceIdr} />
            </p>
            <p className="text-sm text-muted-foreground">{entry.reason}</p>
          </div>
          <FormField
            label={t("paymentAdmin.reconciliation.note")}
            required
            error={error}
            hint={t("paymentAdmin.reconciliation.noteHint")}
          >
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={resolve.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={resolve.isPending}>
              {t("paymentAdmin.reconciliation.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
