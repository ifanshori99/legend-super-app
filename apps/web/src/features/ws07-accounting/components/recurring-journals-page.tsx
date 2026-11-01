// Recurring journal templates (PRD v1.7 §3.19 "Jurnal Berulang"): list,
// create, preview the lines, and the status transitions (submit → approve →
// pause/resume → end). Approval is by someone other than the requester
// (AUTH-06); the mock enforces the same rule as the API.
import * as React from "react";
import {
  Archive,
  CircleCheck,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Plus,
  Send,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { RecurringJournal } from "@starter/shared/accounting";
import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useToast } from "@/components/ui/toast";
import {
  useAccounts,
  useOutlets,
  useRecurringJournals,
  useTransitionRecurringJournal,
} from "../hooks";
import {
  formatPeriod,
  linesTotal,
  recurringJournalActions,
  type RecurringJournalAction,
} from "../lib";
import { ConfirmDialog } from "./confirm-dialog";
import { JournalLinesTable } from "./lines-table";
import { ReasonDialog } from "./reason-dialog";
import { RecurringJournalDialog } from "./recurring-journal-dialog";
import { RecurringJournalStatusBadge } from "./status-badge";

const ACTION_META: Record<
  RecurringJournalAction,
  { labelKey: MessageKey; icon: LucideIcon; destructive?: boolean }
> = {
  submit: { labelKey: "accounting.recurring.actions.submit", icon: Send },
  approve: {
    labelKey: "accounting.recurring.actions.approve",
    icon: CircleCheck,
  },
  reject: {
    labelKey: "accounting.recurring.actions.reject",
    icon: XCircle,
    destructive: true,
  },
  pause: { labelKey: "accounting.recurring.actions.pause", icon: PauseCircle },
  resume: {
    labelKey: "accounting.recurring.actions.resume",
    icon: PlayCircle,
  },
  end: {
    labelKey: "accounting.recurring.actions.end",
    icon: Archive,
    destructive: true,
  },
};

const ACTION_TOAST: Record<RecurringJournalAction, MessageKey> = {
  submit: "accounting.recurring.submitted",
  approve: "accounting.recurring.approved",
  reject: "accounting.recurring.rejected",
  pause: "accounting.recurring.paused",
  resume: "accounting.recurring.resumed",
  end: "accounting.recurring.ended",
};

export function RecurringJournalsPage({
  legalEntityId,
}: {
  legalEntityId: string;
}) {
  const t = useT();
  const toast = useToast();
  const list = useRecurringJournals(legalEntityId);
  const accountsQuery = useAccounts(legalEntityId);
  const outletsQuery = useOutlets();
  const transition = useTransitionRecurringJournal(legalEntityId);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [linesTemplate, setLinesTemplate] =
    React.useState<RecurringJournal | null>(null);
  const [rejecting, setRejecting] = React.useState<RecurringJournal | null>(
    null,
  );
  const [ending, setEnding] = React.useState<RecurringJournal | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const rows = list.data ?? [];
  const state: DataState = list.isPending
    ? "loading"
    : list.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  const accounts = new Map(
    (accountsQuery.data ?? []).map((account) => [account.id, account]),
  );
  const outlets = new Map(
    (outletsQuery.data ?? []).map((outlet) => [outlet.id, outlet.name]),
  );

  const run = async (
    template: RecurringJournal,
    action: Exclude<RecurringJournalAction, "reject">,
  ) => {
    setActionError(null);
    try {
      await transition.mutateAsync({
        recurringJournalId: template.id,
        body: { type: action },
      });
      toast({ title: t(ACTION_TOAST[action]) });
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  const reject = async (reason: string) => {
    if (!rejecting) return;
    setActionError(null);
    try {
      await transition.mutateAsync({
        recurringJournalId: rejecting.id,
        body: { type: "reject", reason },
      });
      toast({ title: t(ACTION_TOAST.reject) });
      setRejecting(null);
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  const addButton = (
    <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
      <Plus aria-hidden="true" />
      {t("accounting.recurring.add")}
    </Button>
  );

  return (
    <div className="grid min-w-0 gap-4">
      {actionError && (
        <p
          role="alert"
          className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
        >
          {actionError}
        </p>
      )}
      <DataTableShell
        title={t("accounting.recurring.title")}
        description={t("accounting.recurring.subtitle")}
        state={state}
        onRetry={() => {
          void list.refetch();
        }}
        actions={state === "empty" ? undefined : addButton}
        empty={{
          title: t("accounting.recurring.emptyTitle"),
          description: t("accounting.recurring.emptyHint"),
          action: addButton,
        }}
      >
        {/* Phones: one card per template; the menu carries the transitions. */}
        <ul className="divide-y divide-border md:hidden">
          {rows.map((template) => (
            <li key={template.id} className="grid gap-2 p-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{template.description}</span>
                  <span className="text-sm text-muted-foreground">
                    {t("accounting.recurring.schedule", {
                      day: template.dayOfMonth,
                    })}{" "}
                    · {formatPeriod(template.startPeriod)} –{" "}
                    {template.endPeriod
                      ? formatPeriod(template.endPeriod)
                      : t("accounting.recurring.openEnded")}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {template.lastGeneratedPeriod
                      ? t("accounting.recurring.lastGenerated", {
                          period: formatPeriod(template.lastGeneratedPeriod),
                        })
                      : t("accounting.recurring.neverGenerated")}
                  </span>
                </span>
                <RecurringJournalStatusBadge status={template.status} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Money amount={linesTotal(template.lines)} size="sm" />
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLinesTemplate(template)}
                  >
                    {t("accounting.recurring.viewLines")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("accounting.recurring.actions.menu")} ${template.description}`}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {recurringJournalActions(template.status).map(
                        (action) => {
                          const meta = ACTION_META[action];
                          const Icon = meta.icon;
                          return (
                            <DropdownMenuItem
                              key={action}
                              destructive={meta.destructive}
                              onSelect={() => {
                                setActionError(null);
                                if (action === "reject") {
                                  setRejecting(template);
                                  return;
                                }
                                if (action === "end") {
                                  setEnding(template);
                                  return;
                                }
                                void run(template, action);
                              }}
                            >
                              <Icon aria-hidden="true" />
                              {t(meta.labelKey)}
                            </DropdownMenuItem>
                          );
                        },
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[48rem]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("accounting.recurring.columns.description")}
                </TableHead>
                <TableHead>
                  {t("accounting.recurring.columns.schedule")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("accounting.recurring.columns.period")}
                </TableHead>
                <TableHead>
                  {t("accounting.recurring.columns.status")}
                </TableHead>
                <TableHead numeric className="hidden sm:table-cell">
                  {t("accounting.recurring.columns.lines")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.manual.columns.total")}
                </TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("common.more")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <span className="font-medium">{template.description}</span>
                    <span className="block text-sm text-muted-foreground">
                      {template.lastGeneratedPeriod
                        ? t("accounting.recurring.lastGenerated", {
                            period: formatPeriod(template.lastGeneratedPeriod),
                          })
                        : t("accounting.recurring.neverGenerated")}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">
                    {t("accounting.recurring.schedule", {
                      day: template.dayOfMonth,
                    })}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap tabular md:table-cell">
                    {formatPeriod(template.startPeriod)} –{" "}
                    {template.endPeriod
                      ? formatPeriod(template.endPeriod)
                      : t("accounting.recurring.openEnded")}
                  </TableCell>
                  <TableCell>
                    <RecurringJournalStatusBadge status={template.status} />
                  </TableCell>
                  <TableCell numeric className="hidden sm:table-cell">
                    {template.lines.length}
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={linesTotal(template.lines)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setLinesTemplate(template)}
                      >
                        {t("accounting.recurring.viewLines")}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${t("accounting.recurring.actions.menu")} ${template.description}`}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {recurringJournalActions(template.status).map(
                            (action) => {
                              const meta = ACTION_META[action];
                              const Icon = meta.icon;
                              return (
                                <DropdownMenuItem
                                  key={action}
                                  destructive={meta.destructive}
                                  onSelect={() => {
                                    setActionError(null);
                                    if (action === "reject") {
                                      setRejecting(template);
                                      return;
                                    }
                                    if (action === "end") {
                                      setEnding(template);
                                      return;
                                    }
                                    void run(template, action);
                                  }}
                                >
                                  <Icon aria-hidden="true" />
                                  {t(meta.labelKey)}
                                </DropdownMenuItem>
                              );
                            },
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>

      <RecurringJournalDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        legalEntityId={legalEntityId}
      />

      <Dialog
        open={linesTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setLinesTemplate(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("accounting.recurring.linesTitle")}</DialogTitle>
            <DialogDescription>{linesTemplate?.description}</DialogDescription>
          </DialogHeader>
          {linesTemplate &&
            (accountsQuery.isPending ? (
              <div className="grid gap-2" aria-busy="true">
                <span className="sr-only">{t("common.loading")}</span>
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            ) : (
              <JournalLinesTable
                lines={linesTemplate.lines}
                accounts={accounts}
                outlets={outlets}
              />
            ))}
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge tone="neutral">
              {t("accounting.recurring.schedule", {
                day: linesTemplate?.dayOfMonth ?? 1,
              })}
            </Badge>
            <span>
              {linesTemplate
                ? `${formatPeriod(linesTemplate.startPeriod)} – ${
                    linesTemplate.endPeriod
                      ? formatPeriod(linesTemplate.endPeriod)
                      : t("accounting.recurring.openEnded")
                  }`
                : null}
            </span>
          </div>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) setRejecting(null);
        }}
        title={t("accounting.recurring.actions.rejectTitle")}
        label={t("accounting.recurring.actions.rejectReason")}
        hint={t("accounting.recurring.actions.rejectReasonHint")}
        submitLabel={t("accounting.recurring.actions.reject")}
        pending={transition.isPending}
        error={actionError ?? undefined}
        onSubmit={(reason) => {
          void reject(reason);
        }}
      />
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        title={t("accounting.recurring.actions.endTitle")}
        description={t("accounting.recurring.actions.endBody")}
        confirmLabel={t("accounting.recurring.actions.endConfirm")}
        pending={transition.isPending}
        onConfirm={() => {
          const template = ending;
          setEnding(null);
          if (template) void run(template, "end");
        }}
      />
    </div>
  );
}
