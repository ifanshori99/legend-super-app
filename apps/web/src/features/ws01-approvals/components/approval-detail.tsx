// Request detail: who asked, why, the value, the proposed change as a diff,
// the countdown and the decision. Shown in a drawer from the inbox and as a
// page at /kelola/persetujuan/$requestId (deep link from a notification).
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ApprovalRequest } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { AiActionForApproval } from "@/features/ws12-ai-action/components/ai-action-summary";
import { useApproval, useNow } from "../hooks";
import {
  actionLabelKey,
  isAgentDraft,
  moduleLabelKey,
  moduleOf,
} from "../logic.ts";
import { DecisionPanel } from "./decision-panel";
import {
  AgentDraftNotice,
  Deadline,
  RequestStatusBadge,
  ShiftDifference,
  SourceBadge,
  formatWhen,
  useApprovalAmount,
  useDiffRows,
  useRequesterName,
  withoutShiftValue,
} from "./parts";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

export function ApprovalDetailBody({
  request,
  access,
  onDecided,
}: {
  request: ApprovalRequest;
  access: AreaAccess;
  onDecided?: (request: ApprovalRequest) => void;
}) {
  const t = useT();
  const now = useNow();
  const requester = useRequesterName(request.requestedBy);
  const decider = useRequesterName(request.decidedBy ?? request.requestedBy);
  const { amount, isShiftClose } = useApprovalAmount(request);
  const rows = withoutShiftValue(
    useDiffRows(request.payload),
    request.actionType,
  );
  return (
    <div className="grid gap-4" data-testid="approval-detail">
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source={request.source} />
        <RequestStatusBadge status={request.status} />
        <Deadline request={request} now={now} />
      </div>

      <AgentDraftNotice source={request.source} onBehalfOf={requester} />

      <AiActionForApproval approvalRequestId={request.id} />

      <dl className="divide-y">
        <Fact label={t("approvals.detail.module")}>
          {t(moduleLabelKey(moduleOf(request.actionType)))}
        </Fact>
        <Fact
          label={t(
            isAgentDraft(request.source)
              ? "approvals.detail.onBehalfOf"
              : "approvals.detail.requester",
          )}
        >
          {requester}
        </Fact>
        {!(isShiftClose && amount === null) && (
          <Fact
            label={t(
              isShiftClose
                ? "approvals.shift.difference"
                : "approvals.detail.value",
            )}
          >
            {amount !== null && isShiftClose ? (
              <ShiftDifference amount={amount} size="md" />
            ) : amount !== null ? (
              <Money amount={amount} />
            ) : (
              "—"
            )}
          </Fact>
        )}
        <Fact label={t("approvals.detail.level")}>
          {t("approvals.level", {
            level: request.level,
            total: request.requiredLevels,
          })}
        </Fact>
        <Fact label={t("approvals.detail.deadline")}>
          {formatWhen(request.deadlineAt)}
        </Fact>
      </dl>

      <section className="grid gap-1">
        <h3 className="type-title">{t("approvals.detail.requestReason")}</h3>
        <p className="text-sm leading-6">{request.requestReason}</p>
      </section>

      <section className="grid gap-2" aria-label={t("approvals.diff.title")}>
        <h3 className="type-title">{t("approvals.diff.title")}</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("approvals.diff.empty")}
          </p>
        ) : (
          <ul
            data-testid="approval-diff"
            className="divide-y rounded-container border-(length:--border-w)"
          >
            {rows.map((row) => (
              <li
                key={row.key}
                data-kind={row.kind}
                className="grid gap-0.5 px-3 py-2 text-sm"
              >
                <span className="text-muted-foreground">{row.label}</span>
                {row.kind === "change" ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="rounded-field bg-danger-subtle px-2 py-0.5 text-danger line-through">
                      <span className="sr-only">
                        {t("approvals.diff.before")}{" "}
                      </span>
                      {row.before}
                    </span>
                    <span aria-hidden="true">→</span>
                    <span className="rounded-field bg-success-subtle px-2 py-0.5 font-semibold text-success">
                      <span className="sr-only">
                        {t("approvals.diff.after")}{" "}
                      </span>
                      {row.after}
                    </span>
                  </span>
                ) : (
                  <span className="font-semibold break-words">{row.after}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(request.status === "approved" || request.status === "rejected") && (
        <section className="grid gap-1 rounded-container border-(length:--border-w) bg-surface-2 p-3">
          <h3 className="type-title">{t("approvals.detail.decided")}</h3>
          <p className="text-sm">
            {t("approvals.detail.decidedBy", {
              name: decider,
              when: request.decidedAt ? formatWhen(request.decidedAt) : "—",
            })}
          </p>
          {request.reason && <p className="text-sm">{request.reason}</p>}
        </section>
      )}

      <DecisionPanel
        request={request}
        now={now}
        canDecide={holdsAny(access, ["approval.request.decide"])}
        onDecided={onDecided}
      />
    </div>
  );
}

function DetailLoader({
  requestId,
  initial,
  access,
  onDecided,
}: {
  requestId: string;
  initial?: ApprovalRequest;
  access: AreaAccess;
  onDecided?: (request: ApprovalRequest) => void;
}) {
  const t = useT();
  const query = useApproval(requestId, initial);
  if (query.isPending)
    return (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-8" />
        <Skeleton className="h-40" />
      </div>
    );
  if (query.isError || !query.data)
    return <ErrorState onRetry={() => void query.refetch()} />;
  return (
    <ApprovalDetailBody
      request={query.data.data}
      access={access}
      onDecided={onDecided}
    />
  );
}

/** Drawer from the inbox; full width on phones, a side panel on desktop. */
export function ApprovalDrawer({
  request,
  access,
  onClose,
}: {
  request: ApprovalRequest | null;
  access: AreaAccess;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Sheet open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:w-[min(32rem,calc(100%-3rem))]">
        <SheetHeader>
          <SheetTitle>
            {request ? t(actionLabelKey(request.actionType)) : ""}
          </SheetTitle>
          <SheetDescription>
            {t("approvals.drawer.description")}
          </SheetDescription>
        </SheetHeader>
        {request && (
          <DetailLoader
            requestId={request.id}
            initial={request}
            access={access}
            onDecided={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Deep link page /kelola/persetujuan/$requestId. */
export function ApprovalDetailPage({
  requestId,
  access,
}: {
  requestId: string;
  access: AreaAccess;
}) {
  const t = useT();
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      <Link
        to="/kelola/persetujuan"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("approvals.backToInbox")}
      </Link>
      <div className="rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <h1 className="type-title mb-3">{t("approvals.detail.title")}</h1>
        <DetailLoader requestId={requestId} access={access} />
      </div>
    </div>
  );
}
