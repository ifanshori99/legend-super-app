// Supervisor detail of one request with approve and reject (bead legend-ydf2,
// mockups detail-*.png, queue-reject-*, queue-success-*, queue-offline-*). A
// page, not a modal, so it deep-links and reads on a phone. A rejection asks a
// reason; a swap that breaks the working-hour rules can only be approved with an
// override reason (HR-05). A decision is never queued offline: it waits for the
// connection and the supervisor retries.
import * as React from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  TriangleAlert,
  Undo2,
  WifiOff,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDecideRequest,
  useRequestDetail,
} from "@/features/hris-requests/hooks";
import type { AreaAccess } from "@/lib/areas/access";
import { useOnline } from "@/lib/use-online";
import type { RequestQueueItem } from "../queue.ts";
import {
  QueueDecisionForm,
  type DecisionFormMode,
} from "./queue-decision-form.tsx";
import { QueueKindPill, useKindLabel } from "./queue-kind-pill.tsx";
import {
  canDecideKind,
  complianceIssueKey,
  formatSubmittedAt,
  isNetworkFailure,
  isQueueKind,
  needsOverride,
  planDecision,
  queueErrorKey,
  requestReason,
  type QueueKind,
} from "./queue-model.ts";
import { QueueOfflineBanner } from "./queue-offline-banner.tsx";
import { QueueStatusPill } from "./queue-status-pill.tsx";

type Decision = "approve" | "reject";
type Attempt = { decision: Decision; reason: string | undefined };

export function QueueDetailPage({
  kind,
  requestId,
}: {
  kind: string;
  requestId: string;
}) {
  const t = useT();
  const back = (
    <Button asChild variant="ghost" className="-ml-2 w-fit">
      <Link to="/kelola/pengajuan">
        <ArrowLeft aria-hidden="true" />
        {t("hrisRequestsQueue.detail.back")}
      </Link>
    </Button>
  );
  return (
    <div className="grid min-w-0 gap-4">
      {back}
      <div className="grid min-w-0 gap-1">
        <h2 className="type-title">{t("hrisRequestsQueue.page.title")}</h2>
        <p className="text-muted-foreground">
          {t("hrisRequestsQueue.page.description")}
        </p>
      </div>
      {isQueueKind(kind) ? (
        <QueueDetailContent kind={kind} requestId={requestId} />
      ) : (
        <NotFound />
      )}
    </div>
  );
}

function NotFound() {
  const t = useT();
  return (
    <EmptyState
      title={t("hrisRequestsQueue.notFound.title")}
      description={t("hrisRequestsQueue.notFound.description")}
      action={
        <Button asChild variant="outline">
          <Link to="/kelola/pengajuan">
            {t("hrisRequestsQueue.detail.back")}
          </Link>
        </Button>
      }
    />
  );
}

function QueueDetailContent({
  kind,
  requestId,
}: {
  kind: QueueKind;
  requestId: string;
}) {
  const t = useT();
  const online = useOnline();
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  const query = useRequestDetail(kind, requestId);
  const decide = useDecideRequest();
  const [mode, setMode] = React.useState<DecisionFormMode | null>(null);
  const [reasonError, setReasonError] = React.useState<string | undefined>();
  // The saved decision is kept here: the queue refetch drops the request from
  // the pending list, and the result must stay on screen.
  const [decided, setDecided] = React.useState<{
    item: RequestQueueItem;
    decision: Decision;
  } | null>(null);
  // The decision that could not be sent (offline), replayed by "Coba lagi".
  const [unsent, setUnsent] = React.useState<Attempt | null>(null);
  const inFlight = React.useRef(false);

  const item = query.data;

  const send = async (attempt: Attempt) => {
    if (item === undefined || inFlight.current) return;
    if (!online) {
      setUnsent(attempt);
      return;
    }
    inFlight.current = true;
    decide.reset();
    try {
      await decide.mutateAsync({
        kind,
        id: item.id,
        decision: attempt.decision,
        reason: attempt.reason,
      });
      setUnsent(null);
      setMode(null);
      setDecided({ item, decision: attempt.decision });
    } catch (error) {
      // A lost connection is retried from the offline panel; other failures
      // show their message next to the actions.
      setUnsent(isNetworkFailure(error) ? attempt : null);
    } finally {
      inFlight.current = false;
    }
  };

  const submit = (decision: Decision, reasonInput: string) => {
    if (item === undefined) return;
    const plan = planDecision(item, decision, reasonInput);
    if (!plan.ok) {
      setReasonError(t("hrisRequestsQueue.overrideForm.reasonRequired"));
      return;
    }
    setReasonError(undefined);
    void send({ decision, reason: plan.reason });
  };

  const openForm = (next: DecisionFormMode) => {
    decide.reset();
    setUnsent(null);
    setReasonError(undefined);
    setMode(next);
  };

  let body: React.ReactNode;
  if (decided !== null) {
    body = <DecisionResult item={decided.item} decision={decided.decision} />;
  } else if (query.isPending) {
    body = <DetailSkeleton label={t("hrisRequestsQueue.loading.label")} />;
  } else if (query.isError && item === undefined) {
    body = (
      <ErrorState
        title={t("hrisRequestsQueue.error.title")}
        description={t("hrisRequestsQueue.error.description")}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (item === undefined) {
    body = <NotFound />;
  } else if (unsent !== null) {
    body = (
      <OfflinePanel
        pending={decide.isPending}
        onRetry={() => void send(unsent)}
      />
    );
  } else {
    const failure =
      decide.error && !isNetworkFailure(decide.error)
        ? t(queueErrorKey(decide.error))
        : null;
    body = (
      <>
        {mode !== null ? (
          <QueueDecisionForm
            mode={mode}
            summary={`${item.title} · ${item.employeeName ?? t("hrisRequestsQueue.detail.unknownEmployee")}`}
            pending={decide.isPending}
            error={reasonError}
            onSubmit={(reason) =>
              submit(mode === "reject" ? "reject" : "approve", reason)
            }
            onCancel={() => setMode(null)}
          />
        ) : (
          <RequestSummary
            item={item}
            canDecide={
              item.status === "pending" &&
              canDecideKind(kind, context.access?.permissions ?? [])
            }
            pending={decide.isPending}
            onApprove={() =>
              needsOverride(item) ? openForm("override") : submit("approve", "")
            }
            onReject={() => openForm("reject")}
          />
        )}
        {failure !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-container bg-danger-subtle p-3 leading-6 text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <p>{failure}</p>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {!online && <QueueOfflineBanner />}
      {body}
    </>
  );
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-6 w-40" />
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[8rem_1fr] gap-3 sm:grid-cols-[12rem_1fr]"
        >
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-32 max-w-full" />
        </div>
      ))}
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function RequestSummary({
  item,
  canDecide,
  pending,
  onApprove,
  onReject,
}: {
  item: RequestQueueItem;
  canDecide: boolean;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const t = useT();
  const kindLabel = useKindLabel()(item);
  const reason = requestReason(item.raw);
  const override = needsOverride(item);
  const issueKeys = (item.complianceIssues ?? [])
    .map((issue) => complianceIssueKey(issue.code))
    .filter((key) => key !== null);

  return (
    <section
      aria-label={kindLabel}
      className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <QueueKindPill item={item} />
        <QueueStatusPill status={item.status} />
      </div>
      <div className="grid gap-0.5">
        <h3 className="type-heading">
          {item.employeeName ?? t("hrisRequestsQueue.detail.unknownEmployee")}
        </h3>
        <p className="text-muted-foreground">
          {t("hrisRequestsQueue.detail.requesting", {
            kind: kindLabel.toLowerCase(),
          })}
        </p>
      </div>
      <dl className="grid gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-2">
        <div className="grid gap-0.5">
          <dt className="text-sm text-muted-foreground">
            {t("hrisRequestsQueue.detail.detailLabel")}
          </dt>
          <dd className="tabular font-medium break-words">{item.period}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-sm text-muted-foreground">
            {t("hrisRequestsQueue.detail.submittedLabel")}
          </dt>
          <dd className="tabular font-medium">
            {formatSubmittedAt(item.submittedAt)}
          </dd>
        </div>
        {reason !== null && (
          <div className="grid gap-0.5 sm:col-span-2">
            <dt className="text-sm text-muted-foreground">
              {t("hrisRequestsQueue.detail.reasonLabel")}
            </dt>
            <dd className="font-medium break-words">{reason}</dd>
          </div>
        )}
      </dl>

      {override && (
        <div
          role="note"
          className="grid gap-1 rounded-container border-l-4 border-warning bg-warning-subtle p-card text-warning"
        >
          <p className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("hrisRequestsQueue.compliance.title")}
          </p>
          <p className="leading-6">
            {t("hrisRequestsQueue.compliance.description")}
          </p>
          {issueKeys.length > 0 && (
            <ul
              className="list-disc pl-5 leading-6"
              aria-label={t("hrisRequestsQueue.compliance.issuesLabel")}
            >
              {issueKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canDecide ? (
        <div className="grid gap-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={onReject}
            >
              {t("hrisRequestsQueue.detail.reject")}
            </Button>
            <Button className="min-h-11" disabled={pending} onClick={onApprove}>
              {override
                ? t("hrisRequestsQueue.detail.approveWithOverride")
                : t("hrisRequestsQueue.detail.approve")}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {override
              ? t("hrisRequestsQueue.detail.overrideHint")
              : t("hrisRequestsQueue.detail.rejectHint")}
          </p>
        </div>
      ) : (
        <p className="leading-6 text-muted-foreground">
          {item.status === "pending"
            ? t("hrisRequestsQueue.detail.noRight")
            : t("hrisRequestsQueue.detail.decidedNote")}
        </p>
      )}
    </section>
  );
}

function OfflinePanel({
  pending,
  onRetry,
}: {
  pending: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <section className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
      <div className="grid gap-1">
        <h3 className="type-heading flex items-center gap-2">
          <WifiOff className="size-5 shrink-0" aria-hidden="true" />
          {t("hrisRequestsQueue.offline.panelTitle")}
        </h3>
        <p className="text-muted-foreground">
          {t("hrisRequestsQueue.offline.panelDescription")}
        </p>
      </div>
      <Button
        variant="outline"
        className="min-h-11 w-full"
        disabled={pending}
        onClick={onRetry}
      >
        {t("hrisRequestsQueue.offline.retry")}
      </Button>
    </section>
  );
}

function DecisionResult({
  item,
  decision,
}: {
  item: RequestQueueItem;
  decision: Decision;
}) {
  const t = useT();
  const heading = React.useRef<HTMLHeadingElement>(null);
  // The form that held focus is gone: the saved heading takes it, so a screen
  // reader announces the outcome.
  React.useEffect(() => heading.current?.focus(), []);
  const approved = decision === "approve";
  return (
    <div className="grid gap-4" data-testid="hris-queue-result">
      <section className="grid gap-1 rounded-container border-l-4 border-success bg-success-subtle p-card">
        <h3
          ref={heading}
          tabIndex={-1}
          className="type-heading flex items-center gap-2 text-success outline-none"
        >
          <CircleCheck className="size-5 shrink-0" aria-hidden="true" />
          {t("hrisRequestsQueue.result.banner")}
        </h3>
        <p className="leading-6">
          {approved
            ? t("hrisRequestsQueue.result.approved")
            : t("hrisRequestsQueue.result.rejected")}
        </p>
      </section>
      <section className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <h3 className="type-heading">
          {item.title} ·{" "}
          {item.employeeName ?? t("hrisRequestsQueue.detail.unknownEmployee")}
        </h3>
        <p className="tabular text-muted-foreground">{item.period}</p>
        <div>
          <QueueStatusPill status={approved ? "approved" : "rejected"} />
        </div>
      </section>
      <div>
        <Button asChild className="w-full sm:w-auto">
          <Link to="/kelola/pengajuan">
            <Undo2 aria-hidden="true" />
            {t("hrisRequestsQueue.result.back")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
