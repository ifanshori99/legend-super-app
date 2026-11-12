// Detail of one AI action request (mockup action-detail.html): the draft the
// AI prepared, what is still pending, and the way into the approval inbox.
// The AI only drafts; a different person approves in the approval inbox.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Clock, Info } from "lucide-react";
import type { ActionRequestReview } from "@starter/shared/ai";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useOnline } from "@/lib/use-online";
import { isMissing, useActionRequestReview } from "../hooks.ts";
import { ActionStatusBadge, AiLabel, DraftLines, formatWhen } from "./parts";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-5 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold break-words">{children}</dd>
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      to="/kelola/tanya-ai"
      className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("aiAction.backToChat")}
    </Link>
  );
}

function DetailSkeleton() {
  const t = useT();
  return (
    <div
      aria-busy="true"
      className="grid gap-5"
      data-testid="ai-action-loading"
    >
      <span className="sr-only">{t("common.loading")}</span>
      <div className="grid gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-48" />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Skeleton className="h-96 rounded-shell" />
        <div className="grid gap-5">
          <Skeleton className="h-40 rounded-shell" />
          <Skeleton className="h-32 rounded-shell" />
        </div>
      </div>
    </div>
  );
}

/** The outcome note under the draft: what, if anything, has changed. */
function StatusNotice({ review }: { review: ActionRequestReview }) {
  const t = useT();
  const { status, resultRef, failureReason } = review.actionRequest;
  const Icon = status === "pending" ? Clock : Info;
  const tone =
    status === "failed" || status === "rejected"
      ? "border-danger bg-danger-subtle"
      : status === "executed"
        ? "border-success bg-success-subtle"
        : "border-warning bg-warning-subtle";
  const body =
    status === "failed"
      ? t("aiAction.notice.failed.body", {
          reason: failureReason ?? "—",
        })
      : t(`aiAction.notice.${status}.body` as MessageKey);
  return (
    <div
      role="note"
      data-testid="ai-action-notice"
      className={`mt-5 grid gap-1 rounded-field border-l-4 p-4 ${tone}`}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4" aria-hidden="true" />
        {t(`aiAction.notice.${status}.title` as MessageKey)}
      </p>
      <p className="text-sm leading-6">{body}</p>
      {status === "executed" && resultRef && (
        <p className="text-sm font-semibold break-words">
          {t("aiAction.notice.executed.result", { ref: resultRef })}
        </p>
      )}
    </div>
  );
}

export function ActionDetailBody({
  review,
  access,
}: {
  review: ActionRequestReview;
  access: AreaAccess;
}) {
  const t = useT();
  const request = review.actionRequest;
  const canOpenInbox = holdsAny(access, ["approval.inbox.view"]);
  return (
    <div className="grid gap-5" data-testid="ai-action-detail">
      <div className="grid gap-3 sm:flex sm:items-start sm:justify-between">
        <h1 className="type-title">{t("aiAction.pageTitle")}</h1>
        <ActionStatusBadge status={request.status} />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <CardShell>
          <CardShellBody className="p-card">
            <section className="grid gap-1 border-b pb-5">
              <AiLabel />
              <h2 className="type-title mt-1">{review.toolTitleId}</h2>
              <p className="text-muted-foreground">
                {t("aiAction.reviewHint")}
              </p>
              <dl className="mt-3 divide-y">
                <Fact label={t("aiAction.facts.outlet")}>
                  {review.outletName ?? t("aiAction.facts.allOutlets")}
                </Fact>
                <Fact label={t("aiAction.facts.type")}>
                  {review.toolTitleId}
                </Fact>
                <Fact label={t("aiAction.facts.requester")}>
                  {review.requestedByName}
                </Fact>
                {request.status === "pending" && (
                  <Fact label={t("aiAction.facts.expiresAt")}>
                    {formatWhen(request.expiresAt)}
                  </Fact>
                )}
              </dl>
            </section>

            <section className="grid gap-1 pt-5" aria-labelledby="ai-summary">
              <h3 id="ai-summary" className="type-heading">
                {t("aiAction.summary.title")}
              </h3>
              {review.summary.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("aiAction.summary.empty")}
                </p>
              ) : (
                <DraftLines lines={review.summary} />
              )}
              <StatusNotice review={review} />
            </section>
          </CardShellBody>
        </CardShell>

        <div className="grid gap-5">
          <CardShell>
            <CardShellBody className="grid gap-4 p-card">
              <div className="grid gap-1">
                <h2 className="type-heading">{t("aiAction.flow.title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("aiAction.flow.intro")}
                </p>
              </div>
              <div className="grid gap-1 border-t pt-4">
                <p className="type-eyebrow text-muted-foreground">
                  {t("aiAction.flow.currentStatus")}
                </p>
                <p className="font-semibold">
                  {t(`aiAction.flow.state.${request.status}` as MessageKey)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("aiAction.flow.differentApprover")}
                </p>
              </div>
            </CardShellBody>
          </CardShell>

          <CardShell>
            <CardShellBody className="grid gap-2 p-card">
              <h2 className="type-heading">{t("aiAction.info.title")}</h2>
              <dl className="divide-y">
                <Fact label={t("aiAction.info.source")}>
                  {t(
                    request.source === "ai"
                      ? "aiAction.info.sourceAi"
                      : "aiAction.info.sourceMcp",
                  )}
                </Fact>
                <Fact label={t("aiAction.info.createdAt")}>
                  {formatWhen(request.createdAt)}
                </Fact>
                {request.executedAt && (
                  <Fact label={t("aiAction.info.executedAt")}>
                    {formatWhen(request.executedAt)}
                  </Fact>
                )}
              </dl>
            </CardShellBody>
          </CardShell>

          {canOpenInbox && (
            <Button
              asChild
              variant="outline"
              className="min-h-11 w-full justify-center sm:w-fit"
            >
              <Link
                to="/kelola/persetujuan/$requestId"
                params={{ requestId: request.approvalRequestId }}
              >
                {t("aiAction.flow.openInbox")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorView({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  const online = useOnline();
  if (isMissing(error))
    return (
      <EmptyState
        title={t("aiAction.states.notFoundTitle")}
        description={t("aiAction.states.notFoundHint")}
        action={
          <Button asChild variant="outline" className="min-h-11">
            <Link to="/kelola/tanya-ai">{t("aiAction.backToChat")}</Link>
          </Button>
        }
      />
    );
  const offline =
    !online || (error instanceof ApiError && error.code === "NETWORK_ERROR");
  return (
    <ErrorState
      error={error}
      title={t("aiAction.states.errorTitle")}
      description={
        offline
          ? t("aiAction.states.offlineHint")
          : t("aiAction.states.errorHint")
      }
      onRetry={onRetry}
    />
  );
}

/** Page body for /kelola/tanya-ai/aksi/$actionRequestId. */
export function ActionDetailPage({
  actionRequestId,
  access,
}: {
  actionRequestId: string;
  access: AreaAccess;
}) {
  const { request, review } = useActionRequestReview(actionRequestId);
  let content: ReactNode;
  if (request.isError)
    content = (
      <ErrorView error={request.error} onRetry={() => void request.refetch()} />
    );
  else if (review.isError)
    content = (
      <ErrorView error={review.error} onRetry={() => void review.refetch()} />
    );
  else if (!review.data) content = <DetailSkeleton />;
  else content = <ActionDetailBody review={review.data.data} access={access} />;
  return (
    <div className="grid w-full min-w-0 gap-3">
      <div>
        <BackLink />
      </div>
      {content}
    </div>
  );
}
