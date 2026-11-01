// Journal detail: the lines, the ACC-01 balance verdict, the source document
// one step away (ACC-03), and the only correction path — a reversing journal
// (ACC-01). Posted entries are final; the screen never offers edit or delete.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Link2 } from "lucide-react";
import type { JournalEntry } from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  useAccounts,
  useJournal,
  useLegalEntities,
  useOutlets,
  useReverseJournal,
} from "../hooks";
import {
  JOURNAL_SOURCE_KEYS,
  businessDateToday,
  formatBusinessDate,
  formatDateTime,
  journalReversalState,
  journalSourceInfo,
} from "../lib";
import { AccountingPage } from "./accounting-shell";
import { JournalLinesTable } from "./lines-table";

export function JournalDetailPage({
  journalEntryId,
}: {
  journalEntryId: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const journalQuery = useJournal(journalEntryId);
  const entry = journalQuery.data?.entry;
  const reversedBy = journalQuery.data?.reversedBy ?? null;
  const accountsQuery = useAccounts(entry?.legalEntityId);
  const outletsQuery = useOutlets();
  const entitiesQuery = useLegalEntities();
  const reverse = useReverseJournal(journalEntryId);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [entryDate, setEntryDate] = React.useState(businessDateToday());
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<{
    entryDate?: string;
    reason?: string;
    server?: string;
  }>({});

  if (journalQuery.isPending)
    return (
      <AccountingPage active="journals">
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </AccountingPage>
    );

  if (journalQuery.isError) {
    const status =
      journalQuery.error instanceof ApiError ? journalQuery.error.status : 0;
    return (
      <AccountingPage active="journals">
        {status === 404 ? (
          <EmptyState
            title={t("accounting.journals.notFoundTitle")}
            description={t("accounting.journals.notFoundHint")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/akuntansi/jurnal">
                  {t("accounting.journal.back")}
                </Link>
              </Button>
            }
          />
        ) : (
          <ErrorState
            onRetry={() => {
              void journalQuery.refetch();
            }}
          />
        )}
      </AccountingPage>
    );
  }

  const journal: JournalEntry = journalQuery.data.entry;
  const accounts = new Map(
    (accountsQuery.data ?? []).map((account) => [account.id, account]),
  );
  const outlets = new Map(
    (outletsQuery.data ?? []).map((outlet) => [outlet.id, outlet.name]),
  );
  const entityName = entitiesQuery.data?.find(
    (entity) => entity.id === journal.legalEntityId,
  )?.name;
  const source = journalSourceInfo(journal);
  const reversalState = journalReversalState(journal, reversedBy);
  const outletName = journal.outletId
    ? (outlets.get(journal.outletId) ?? journal.outletId)
    : t("accounting.journal.outletNone");

  const closeDialog = (open: boolean) => {
    setDialogOpen(open);
    if (open) {
      setEntryDate(businessDateToday());
      setReason("");
      setErrors({});
    }
  };

  const submitReversal = async () => {
    const nextErrors: typeof errors = {};
    if (entryDate === "") nextErrors.entryDate = t("form.invalid");
    if (reason.trim() === "") nextErrors.reason = t("form.invalid");
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      const reversal = await reverse.mutateAsync({
        entryDate,
        reason: reason.trim(),
      });
      toast({ title: t("accounting.journal.reversed") });
      setDialogOpen(false);
      void navigate({
        to: "/kelola/akuntansi/jurnal/$journalEntryId",
        params: { journalEntryId: reversal.id },
      });
    } catch (error) {
      setErrors({
        server:
          error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      });
    }
  };

  return (
    <AccountingPage active="journals">
      <div className="grid gap-4">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/kelola/akuntansi/jurnal">
              <ArrowLeft aria-hidden="true" />
              {t("accounting.journal.back")}
            </Link>
          </Button>
        </div>

        <section className="rounded-xl border-(length:--border-w) border-border bg-card">
          <header className="grid gap-2 border-b border-border p-card">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl leading-7 font-semibold">
                {journal.description}
              </h2>
              {reversalState === "reversed" && (
                <Badge tone="warning">
                  {t("accounting.journals.reversed")}
                </Badge>
              )}
              {reversalState === "reversal" && (
                <Badge tone="info">{t("accounting.journals.reversal")}</Badge>
              )}
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {formatBusinessDate(journal.entryDate)}
              {entityName ? ` · ${entityName}` : ""}
            </p>
          </header>
          <dl className="grid gap-4 p-card sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("accounting.journals.columns.date")}
              </dt>
              <dd className="tabular">
                {formatBusinessDate(journal.entryDate)}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("accounting.journals.columns.source")}
              </dt>
              <dd>{t(JOURNAL_SOURCE_KEYS[journal.sourceType])}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("accounting.journal.columns.outlet")}
              </dt>
              <dd>{outletName}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("accounting.journal.postedAt")}
              </dt>
              <dd className="tabular">
                {formatDateTime(journal.postedAt)}
                <span className="block text-sm text-muted-foreground">
                  {journal.postedBy === null
                    ? t("accounting.journal.postedBySystem")
                    : t("accounting.journal.postedByUser")}
                </span>
              </dd>
            </div>
          </dl>
          {accountsQuery.isPending ? (
            <div className="grid gap-2 p-card" aria-busy="true">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          ) : (
            <JournalLinesTable
              lines={journal.lines}
              accounts={accounts}
              outlets={outlets}
            />
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="grid content-start gap-3 rounded-xl border-(length:--border-w) border-border bg-card p-card">
            <h3 className="text-lg leading-7 font-semibold">
              {t("accounting.journal.sourceTitle")}
            </h3>
            <dl className="grid gap-1 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">
                  {t("accounting.journal.sourceType")}
                </dt>
                <dd>{t(source.labelKey)}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">
                  {t("accounting.journal.sourceRef")}
                </dt>
                <dd className="font-mono break-all">
                  {source.reference ?? t("accounting.journal.empty")}
                </dd>
              </div>
            </dl>
            {source.link ? (
              <div>
                <Button asChild variant="outline" size="sm">
                  {source.link.screen === "manualJournal" ? (
                    <Link
                      to="/kelola/akuntansi/jurnal-manual/$manualJournalId"
                      params={{ manualJournalId: source.link.id ?? "" }}
                    >
                      <Link2 aria-hidden="true" />
                      {t("accounting.journal.sourceOpen")}
                    </Link>
                  ) : source.link.screen === "journal" ? (
                    <Link
                      to="/kelola/akuntansi/jurnal/$journalEntryId"
                      params={{ journalEntryId: source.link.id ?? "" }}
                    >
                      <Link2 aria-hidden="true" />
                      {t("accounting.journal.sourceOpen")}
                    </Link>
                  ) : (
                    <Link to="/kelola/akuntansi/jurnal-berulang">
                      <Link2 aria-hidden="true" />
                      {t("accounting.journal.sourceOpen")}
                    </Link>
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.journal.sourceNoLink")}
              </p>
            )}
          </section>

          <section className="grid content-start gap-3 rounded-xl border-(length:--border-w) border-border bg-card p-card">
            <h3 className="text-lg leading-7 font-semibold">
              {t("accounting.journal.correction")}
            </h3>
            {reversalState === "reversal" && journal.reversalOf && (
              <Button asChild variant="outline" size="sm" className="w-fit">
                <Link
                  to="/kelola/akuntansi/jurnal/$journalEntryId"
                  params={{ journalEntryId: journal.reversalOf }}
                >
                  <ExternalLink aria-hidden="true" />
                  {t("accounting.journal.reversalOf")}
                </Link>
              </Button>
            )}
            {reversalState === "reversed" && reversedBy && (
              <div className="grid gap-2">
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("accounting.journal.alreadyReversed")}
                </p>
                <Button asChild variant="outline" size="sm" className="w-fit">
                  <Link
                    to="/kelola/akuntansi/jurnal/$journalEntryId"
                    params={{ journalEntryId: reversedBy }}
                  >
                    <ExternalLink aria-hidden="true" />
                    {t("accounting.journal.reversedBy")}
                  </Link>
                </Button>
              </div>
            )}
            {reversalState === "reversible" && (
              <div className="grid gap-2">
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("accounting.journal.reverseHint")}
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="w-fit"
                  onClick={() => closeDialog(true)}
                >
                  {t("accounting.journal.reverse")}
                </Button>
              </div>
            )}
            {reversalState === "reversal" && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.journal.reversalNote")}
              </p>
            )}
          </section>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={closeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accounting.journal.reverseTitle")}</DialogTitle>
            <DialogDescription>
              {t("accounting.journal.reverseHint")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitReversal();
            }}
          >
            <FormField
              label={t("accounting.journal.reverseDate")}
              error={errors.entryDate}
              required
            >
              <Input
                type="date"
                value={entryDate}
                onChange={(event) => setEntryDate(event.target.value)}
                className="tabular"
              />
            </FormField>
            <FormField
              label={t("accounting.journal.reverseReason")}
              hint={t("accounting.journal.reverseReasonHint")}
              error={errors.reason}
              required
            >
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                maxLength={200}
              />
            </FormField>
            {errors.server && (
              <p
                role="alert"
                className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
              >
                {errors.server}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={reverse.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={reverse.isPending}>
                {t("accounting.journal.reverseSubmit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AccountingPage>
  );
}
