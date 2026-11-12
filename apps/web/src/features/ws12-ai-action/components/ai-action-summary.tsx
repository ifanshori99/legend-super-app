// AI section of the approval inbox detail: when an approval request came from
// an AI draft, show who prepared it and what changes, with a link to the full
// action request. Renders nothing for approvals without an AI action.
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ActionRequestReview } from "@starter/shared/ai";
import { useT } from "@/components/i18n";
import { useAiActionForApproval } from "../hooks.ts";
import { ActionStatusBadge, AiLabel, DraftLines } from "./parts";

const MAX_LINES = 4;

export function AiActionSummary({ review }: { review: ActionRequestReview }) {
  const t = useT();
  const request = review.actionRequest;
  const lines = review.summary.slice(0, MAX_LINES);
  const hidden = review.summary.length - lines.length;
  const source = t(
    request.source === "ai"
      ? "aiAction.info.sourceAi"
      : "aiAction.info.sourceMcp",
  );
  return (
    <section
      className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3"
      aria-label={t("aiAction.inbox.title")}
      data-testid="ai-action-section"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AiLabel />
        <ActionStatusBadge status={request.status} />
      </div>
      <h3 className="type-heading">
        {t("aiAction.inbox.heading", { source })}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t("aiAction.inbox.onBehalfOf", {
          name: review.requestedByName,
          tool: review.toolTitleId,
        })}
      </p>
      {lines.length > 0 && <DraftLines lines={lines} />}
      {hidden > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("aiAction.inbox.moreLines", { count: hidden })}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {t("aiAction.inbox.note")}
      </p>
      <Link
        to="/kelola/tanya-ai/aksi/$actionRequestId"
        params={{ actionRequestId: request.id }}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary"
      >
        {t("aiAction.inbox.viewDetail")}
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </section>
  );
}

/** Loads the AI action of one approval request; nothing shows while loading, missing or failed. */
export function AiActionForApproval({
  approvalRequestId,
}: {
  approvalRequestId: string;
}) {
  const query = useAiActionForApproval(approvalRequestId);
  if (!query.data) return null;
  return <AiActionSummary review={query.data.data} />;
}
