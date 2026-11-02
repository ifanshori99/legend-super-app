// Manual journal detail and the approval flow (PRD v1.7 §3.19 "Jurnal Manual &
// Berulang"; AUTH-06 "penyetuju berbeda dari pemohon"). The screen offers only
// the transitions the contract allows from the current status, and approval
// posts the entry in the same operation. The API re-checks the actor.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Pencil } from "lucide-react";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  useAccounts,
  useLegalEntities,
  useManualJournal,
  useManualJournalCommand,
  useOutlets,
} from "../hooks";
import {
  MANUAL_KIND_KEYS,
  formatBusinessDate,
  formatDateTime,
  manualJournalActions,
} from "../lib";
import { AccountingPage } from "./accounting-shell";
import { ConfirmDialog } from "./confirm-dialog";
import { JournalLinesTable } from "./lines-table";
import { ReasonDialog } from "./reason-dialog";
import { ManualJournalStatusBadge } from "./status-badge";

export function ManualJournalDetailPage({
  manualJournalId,
  canPost,
}: {
  manualJournalId: string;
  /** Holds `accounting.journal.post`: approval/rejection is theirs (AUTH-06). */
  canPost: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const journalQuery = useManualJournal(manualJournalId);
  const journal = journalQuery.data;
  const accountsQuery = useAccounts(journal?.legalEntityId);
  const outletsQuery = useOutlets();
  const entitiesQuery = useLegalEntities();
  const command = useManualJournalCommand(manualJournalId);

  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const run = async (next: "submit" | "withdraw" | "approve" | "cancel") => {
    setActionError(null);
    try {
      await command.mutateAsync({ command: next });
      toast({
        title:
          next === "submit"
            ? t("accounting.manual.submitted")
            : next === "withdraw"
              ? t("accounting.manual.withdrawn")
              : next === "approve"
                ? t("accounting.manual.approved")
                : t("accounting.manual.cancelled"),
      });
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  const reject = async (reason: string) => {
    setActionError(null);
    try {
      await command.mutateAsync({ command: "reject", reason });
      toast({ title: t("accounting.manual.rejected") });
      setRejectOpen(false);
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  if (journalQuery.isPending)
    return (
      <AccountingPage active="manual">
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
      <AccountingPage active="manual">
        {status === 404 ? (
          <EmptyState
            title={t("accounting.manual.notFoundTitle")}
            description={t("accounting.manual.notFoundHint")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/akuntansi/jurnal-manual">
                  {t("accounting.manual.detail.back")}
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

  const row = journalQuery.data;
  const accounts = new Map(
    (accountsQuery.data ?? []).map((account) => [account.id, account]),
  );
  const outlets = new Map(
    (outletsQuery.data ?? []).map((outlet) => [outlet.id, outlet.name]),
  );
  const entityName = entitiesQuery.data?.find(
    (entity) => entity.id === row.legalEntityId,
  )?.name;
  // View-only users see the status and lines but no write action.
  const actions = canPost ? manualJournalActions(row.status) : [];
  const canDecide = actions.includes("approve") && canPost;

  return (
    <AccountingPage active="manual">
      <div className="grid gap-4">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/kelola/akuntansi/jurnal-manual">
              <ArrowLeft aria-hidden="true" />
              {t("accounting.manual.detail.back")}
            </Link>
          </Button>
        </div>

        <CardShell>
          <CardShellBody>
            <header className="grid gap-2 border-b border-border p-card">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="type-title">{row.description}</h2>
                <ManualJournalStatusBadge status={row.status} />
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                {t(MANUAL_KIND_KEYS[row.kind])} ·{" "}
                {formatBusinessDate(row.entryDate)}
                {entityName ? ` · ${entityName}` : ""}
              </p>
            </header>
            <dl className="grid gap-4 p-card sm:grid-cols-2 lg:grid-cols-3">
              <div className="grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">
                  {t("accounting.manual.detail.createdAt")}
                </dt>
                <dd className="tabular">{formatDateTime(row.createdAt)}</dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">
                  {t("accounting.manual.detail.submittedAt")}
                </dt>
                <dd className="tabular">
                  {row.submittedAt
                    ? formatDateTime(row.submittedAt)
                    : t("accounting.journal.empty")}
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">
                  {t("accounting.manual.detail.decidedAt")}
                </dt>
                <dd className="tabular">
                  {row.decidedAt
                    ? formatDateTime(row.decidedAt)
                    : t("accounting.journal.empty")}
                </dd>
              </div>
              {row.rejectionReason && (
                <div className="grid gap-0.5 sm:col-span-2 lg:col-span-3">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("accounting.manual.detail.rejectionReason")}
                  </dt>
                  <dd>{row.rejectionReason}</dd>
                </div>
              )}
              {row.postedEntryId && (
                <div className="grid gap-1 sm:col-span-2 lg:col-span-3">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("accounting.manual.detail.postedEntry")}
                  </dt>
                  <dd>
                    <Button asChild variant="outline" size="sm">
                      <Link
                        to="/kelola/akuntansi/jurnal/$journalEntryId"
                        params={{ journalEntryId: row.postedEntryId }}
                      >
                        <ExternalLink aria-hidden="true" />
                        {t("accounting.manual.detail.openPosted")}
                      </Link>
                    </Button>
                  </dd>
                </div>
              )}
            </dl>
            {accountsQuery.isPending ? (
              <div className="grid gap-2 p-card" aria-busy="true">
                <span className="sr-only">{t("common.loading")}</span>
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            ) : (
              <JournalLinesTable
                lines={row.lines}
                accounts={accounts}
                outlets={outlets}
              />
            )}
          </CardShellBody>
        </CardShell>

        <section
          aria-label={t("accounting.manual.actions.approve")}
          className="grid gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline"
        >
          {row.status === "pending_approval" && (
            <p className="text-sm leading-5 text-muted-foreground">
              {canPost
                ? t("accounting.manual.detail.approverHint")
                : t("accounting.manual.detail.permissionHint")}
            </p>
          )}
          {actionError && (
            <p
              role="alert"
              className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
            >
              {actionError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {actions.includes("edit") && (
              <Button asChild variant="outline" size="sm">
                <Link
                  to="/kelola/akuntansi/jurnal-manual/$manualJournalId/ubah"
                  params={{ manualJournalId: row.id }}
                >
                  <Pencil aria-hidden="true" />
                  {t("accounting.manual.actions.edit")}
                </Link>
              </Button>
            )}
            {actions.includes("submit") && (
              <Button
                type="button"
                size="sm"
                loading={command.isPending}
                onClick={() => {
                  void run("submit");
                }}
              >
                {t("accounting.manual.actions.submit")}
              </Button>
            )}
            {actions.includes("withdraw") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={command.isPending}
                onClick={() => {
                  void run("withdraw");
                }}
              >
                {t("accounting.manual.actions.withdraw")}
              </Button>
            )}
            {canDecide && (
              <Button
                type="button"
                size="sm"
                loading={command.isPending}
                onClick={() => {
                  void run("approve");
                }}
              >
                {t("accounting.manual.actions.approve")}
              </Button>
            )}
            {canDecide && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={command.isPending}
                onClick={() => {
                  setActionError(null);
                  setRejectOpen(true);
                }}
              >
                {t("accounting.manual.actions.reject")}
              </Button>
            )}
            {actions.includes("cancel") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={command.isPending}
                onClick={() => setCancelOpen(true)}
              >
                {t("accounting.manual.actions.cancel")}
              </Button>
            )}
          </div>
          {actions.length === 0 && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("accounting.journals.subtitle")}
            </p>
          )}
        </section>
      </div>

      <ReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={t("accounting.manual.actions.rejectTitle")}
        label={t("accounting.manual.actions.rejectReason")}
        hint={t("accounting.manual.actions.rejectReasonHint")}
        submitLabel={t("accounting.manual.actions.rejectSubmit")}
        pending={command.isPending}
        error={actionError ?? undefined}
        onSubmit={(reason) => {
          void reject(reason);
        }}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t("accounting.manual.actions.cancelTitle")}
        description={t("accounting.manual.actions.cancelBody")}
        confirmLabel={t("accounting.manual.actions.cancelConfirm")}
        pending={command.isPending}
        onConfirm={() => {
          setCancelOpen(false);
          void run("cancel");
        }}
      />
    </AccountingPage>
  );
}
