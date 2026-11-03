// Reviews & complaints queue (/kelola/ulasan; PRD v1.7 §3.21 "Ulasan &
// Keluhan": post-meal ratings, complaints with a follow-up queue and the AI-11
// summary). Filters and the action buttons follow the CRM contract's feedback
// state machine; resolved rows carry no action here (the brief lists
// start_review / resolve / dismiss only).
//
// The AI-11 panel sits above the queue and is computed from the rows the queue
// loaded, so the screen never shows a number the table cannot explain.
import * as React from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { Lock, RotateCw } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type {
  Feedback,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
} from "@starter/shared/crm";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
import { useCustomers, useFeedback, useUpdateFeedback } from "../hooks";
import {
  FEEDBACK_ACTIONS,
  feedbackActionKey,
  formatDateTime,
  shortRef,
} from "../lib";
import { useCrm360T } from "../t";
import { AiSummaryPanel } from "./ai-summary-panel";
import {
  CursorPager,
  FeedbackKindBadge,
  FeedbackStatusPill,
  Notice,
  ReadProblem,
} from "./crm-shell";

const PAGE_SIZE = 20;
const ALL = "all";

const STATUSES: readonly FeedbackStatus[] = [
  "open",
  "in_review",
  "resolved",
  "closed",
];
const KINDS: readonly FeedbackKind[] = ["rating", "complaint"];

export function FeedbackPage() {
  const t = useCrm360T();
  const common = useT();
  const toast = useToast();
  const { access } = useRouteContext({ strict: false }) as {
    access: AreaAccess;
  };
  const canRespond = holdsAny(access, ["review.respond"]);
  const canViewCustomer = holdsAny(access, ["crm.customer.view"]);

  const [status, setStatus] = React.useState<string>(ALL);
  const [kind, setKind] = React.useState<string>(ALL);
  const [cursors, setCursors] = React.useState<(string | undefined)[]>([
    undefined,
  ]);
  const cursor = cursors.at(-1);

  const feedback = useFeedback({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(status === ALL ? {} : { status: status as FeedbackStatus }),
    ...(kind === ALL ? {} : { kind: kind as FeedbackKind }),
  });
  // Customer names are resolved from the CRM directory; the feedback DTO
  // carries only the profile id.
  const customers = useCustomers({ limit: 100 });
  const mutation = useUpdateFeedback();

  const rows = feedback.data?.data ?? [];
  const nextCursor = feedback.data?.meta.nextCursor ?? null;
  const filtered = status !== ALL || kind !== ALL;
  const customerNames = new Map(
    (customers.data?.data ?? []).map((profile) => [profile.id, profile.name]),
  );

  function resetPages() {
    setCursors([undefined]);
  }

  function clearFilters() {
    setStatus(ALL);
    setKind(ALL);
    resetPages();
  }

  function act(entry: Feedback, action: FeedbackAction) {
    mutation.mutate(
      { feedbackId: entry.id, action },
      {
        onSuccess: () =>
          toast({
            title: t("crm360.feedback.actionSuccess"),
            tone: "success",
          }),
        onError: () =>
          toast({ title: t("crm360.feedback.actionFailed"), tone: "danger" }),
      },
    );
  }

  const state = feedback.isPending
    ? "loading"
    : rows.length === 0
      ? "empty"
      : "ready";

  function customerCell(entry: Feedback) {
    if (entry.customerProfileId === null)
      return (
        <span className="text-muted-foreground">
          {t("crm360.feedback.unknownCustomer")}
        </span>
      );
    const name = customerNames.get(entry.customerProfileId);
    if (name === undefined)
      return (
        <span className="text-muted-foreground" title={entry.customerProfileId}>
          {t("crm360.feedback.unknownCustomer")}
        </span>
      );
    if (!canViewCustomer) return <span>{name}</span>;
    return (
      <Link
        to="/kelola/pelanggan/$customerProfileId"
        params={{ customerProfileId: entry.customerProfileId }}
        aria-label={t("crm360.customers.openDetail", { name })}
        className="font-medium underline-offset-4 hover:underline"
      >
        {name}
      </Link>
    );
  }

  function ratingCell(entry: Feedback) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <FeedbackKindBadge kind={entry.kind} />
        {entry.kind === "rating" && entry.rating !== null && (
          <span className="text-sm font-medium tabular">
            {t("crm360.feedback.ratingLabel", { rating: entry.rating })}
          </span>
        )}
      </div>
    );
  }

  function actionsCell(entry: Feedback) {
    const actions = FEEDBACK_ACTIONS[entry.status];
    if (actions.length === 0)
      return (
        <span className="text-sm text-muted-foreground">
          {t("crm360.feedback.noAction")}
        </span>
      );
    return (
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            disabled={!canRespond || mutation.isPending}
            onClick={() => act(entry, action)}
          >
            {t(feedbackActionKey(action))}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      {feedback.isError && feedback.data === undefined ? null : (
        <AiSummaryPanel rows={rows} loading={feedback.isPending} />
      )}

      {!canRespond && (
        <Notice tone="warning" icon={Lock}>
          {t("crm360.feedback.locked")}
        </Notice>
      )}

      {feedback.isError && feedback.data === undefined ? (
        <ReadProblem
          error={feedback.error}
          title={t("crm360.feedback.loadError")}
          hint={t("crm360.feedback.loadHint")}
          offlineTitle={t("crm360.feedback.offlineTitle")}
          offlineHint={t("crm360.feedback.offlineHint")}
          onRetry={() => void feedback.refetch()}
        />
      ) : (
        <DataTableShell
          title={t("crm360.feedback.title")}
          description={t("crm360.feedback.description")}
          state={state}
          actions={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value);
                  resetPages();
                }}
              >
                <SelectTrigger
                  aria-label={t("crm360.feedback.filterStatus")}
                  className="sm:w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("crm360.feedback.allStatuses")}
                  </SelectItem>
                  {STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`crm360.feedback.statuses.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={kind}
                onValueChange={(value) => {
                  setKind(value);
                  resetPages();
                }}
              >
                <SelectTrigger
                  aria-label={t("crm360.feedback.filterKind")}
                  className="sm:w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("crm360.feedback.allKinds")}
                  </SelectItem>
                  {KINDS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`crm360.feedback.kinds.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
          onRetry={() => void feedback.refetch()}
          empty={
            filtered
              ? {
                  title: t("crm360.feedback.filteredTitle"),
                  description: t("crm360.feedback.filteredHint"),
                  action: (
                    <Button variant="outline" size="sm" onClick={clearFilters}>
                      {t("crm360.feedback.clearFilters")}
                    </Button>
                  ),
                }
              : {
                  title: t("crm360.feedback.emptyTitle"),
                  description: t("crm360.feedback.emptyHint"),
                  action: (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={feedback.isFetching}
                      onClick={() => void feedback.refetch()}
                    >
                      <RotateCw aria-hidden="true" />
                      {common("common.retry")}
                    </Button>
                  ),
                }
          }
          loadingRows={5}
        >
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("crm360.feedback.columns.rating")}</TableHead>
                  <TableHead>{t("crm360.feedback.columns.customer")}</TableHead>
                  <TableHead>{t("crm360.feedback.columns.outlet")}</TableHead>
                  <TableHead>{t("crm360.feedback.columns.comment")}</TableHead>
                  <TableHead>{t("crm360.feedback.columns.created")}</TableHead>
                  <TableHead>{t("crm360.feedback.columns.status")}</TableHead>
                  <TableHead>{t("crm360.feedback.columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{ratingCell(entry)}</TableCell>
                    <TableCell>{customerCell(entry)}</TableCell>
                    <TableCell title={entry.outletId}>
                      <span className="tabular">
                        {t("crm360.feedback.outletRef", {
                          ref: shortRef(entry.outletId),
                        })}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-80">
                      <span className="block break-words">
                        {entry.comment ?? t("crm360.feedback.noComment")}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell>
                      <FeedbackStatusPill status={entry.status} />
                    </TableCell>
                    <TableCell>{actionsCell(entry)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="md:hidden">
            {rows.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {ratingCell(entry)}
                  <FeedbackStatusPill status={entry.status} />
                </div>
                <div className="grid gap-0.5">
                  {entry.customerProfileId !== null && (
                    <span className="text-sm font-medium">
                      {customerCell(entry)}
                    </span>
                  )}
                  <span className="text-sm leading-5 break-words">
                    {entry.comment ?? t("crm360.feedback.noComment")}
                  </span>
                </div>
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("crm360.feedback.columns.outlet")}:
                    </dt>
                    <dd className="min-w-0 break-words tabular">
                      {t("crm360.feedback.outletRef", {
                        ref: shortRef(entry.outletId),
                      })}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("crm360.feedback.columns.created")}:
                    </dt>
                    <dd className="min-w-0 break-words tabular">
                      {formatDateTime(entry.createdAt)}
                    </dd>
                  </div>
                </dl>
                <div>{actionsCell(entry)}</div>
              </li>
            ))}
          </ul>

          <CursorPager
            countLabel={t("crm360.feedback.rowCount", {
              count: formatNumber(rows.length),
            })}
            canPrevious={cursors.length > 1}
            canNext={nextCursor !== null}
            pending={feedback.isFetching}
            onPrevious={() => setCursors((current) => current.slice(0, -1))}
            onNext={() => {
              if (nextCursor === null) return;
              setCursors((current) => [...current, nextCursor]);
            }}
          />
        </DataTableShell>
      )}
    </div>
  );
}
