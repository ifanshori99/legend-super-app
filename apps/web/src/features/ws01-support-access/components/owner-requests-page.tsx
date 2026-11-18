// /kelola/akses-dukungan/permintaan: the Owner decides read_write support
// access requests, watches the running grant and can revoke it
// (bead legend-8r77t; PRD v1.7 §3 F4, TEN-04). Mockup:
// design/mockups/platform/support-access-*.png.
//
// Decisions are Owner-only, need a verified second factor and are refused in
// an impersonated session: the buttons switch off with the reason in words,
// and the API checks again (403 IMPERSONATION_NOT_ALLOWED / MFA_REQUIRED).
import * as React from "react";
import {
  CircleCheck,
  CircleSlash,
  Clock,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardShell } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOnline } from "@/lib/use-online";
import {
  useApproveSupportAccessRequest,
  useEndSupportAccess,
  useOrgGrants,
  useRejectSupportAccessRequest,
  useSupportAccessRequests,
  useSupportDecisionGuard,
} from "../hooks.ts";
import { clockSkewMs } from "../logic.ts";
import { useSecondClock } from "../use-now.ts";
import { OwnerActiveCard } from "./owner-active-card.tsx";
import {
  decisionBlock,
  decisionErrorKind,
  revokeErrorKind,
  requestsFromResult,
  sectionRequests,
  shortId,
  type DecisionBlock,
  type DecisionErrorKind,
  type RequestDisplayStatus,
} from "./owner-logic.ts";
import { OwnerDetail, OwnerPendingCard } from "./owner-request-card.tsx";
import { formatInstant } from "./shared.tsx";

const BLOCK_TEXT: Record<DecisionBlock, MessageKey> = {
  offline: "supportAccessOwner.blocked.offline",
  impersonating: "supportAccessOwner.blocked.impersonating",
  mfa_required: "supportAccessOwner.blocked.mfaRequired",
  not_owner: "supportAccessOwner.blocked.notOwner",
};

const ERROR_TEXT: Record<DecisionErrorKind, MessageKey> = {
  offline: "supportAccessOwner.errors.offline",
  impersonating: "supportAccessOwner.errors.impersonating",
  mfa: "supportAccessOwner.errors.mfa",
  forbidden: "supportAccessOwner.errors.forbidden",
  conflict: "supportAccessOwner.errors.conflict",
  revokeUnavailable: "supportAccessOwner.errors.revokeUnavailable",
  generic: "supportAccessOwner.errors.generic",
};

type Notice = "approved" | "rejected" | "revoked";

const NOTICE_TEXT: Record<Notice, { title: MessageKey; body: MessageKey }> = {
  approved: {
    title: "supportAccessOwner.notice.approvedTitle",
    body: "supportAccessOwner.notice.approvedBody",
  },
  rejected: {
    title: "supportAccessOwner.notice.rejectedTitle",
    body: "supportAccessOwner.notice.rejectedBody",
  },
  revoked: {
    title: "supportAccessOwner.notice.revokedTitle",
    body: "supportAccessOwner.notice.revokedBody",
  },
};

function Banner({
  tone,
  icon: Icon,
  title,
  children,
  role = "status",
}: {
  tone: "success" | "warning" | "danger";
  icon: typeof CircleCheck;
  title: string;
  children?: React.ReactNode;
  role?: "status" | "alert";
}) {
  const toneClass = {
    success: "border-success bg-success-subtle",
    warning: "border-warning bg-warning-subtle",
    danger: "border-danger bg-danger-subtle",
  }[tone];
  const iconClass = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];
  return (
    <Card
      role={role}
      className={`flex-row items-start gap-3 text-foreground ${toneClass}`}
    >
      <Icon
        className={`mt-0.5 size-icon shrink-0 ${iconClass}`}
        aria-hidden="true"
      />
      <p className="text-sm">
        <strong className="font-semibold">{title}</strong>
        {children && <> {children}</>}
      </p>
    </Card>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <CardShell className="gap-2" aria-busy="true">
      <Card>
        <span className="sr-only">{label}</span>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-11 w-48" />
      </Card>
    </CardShell>
  );
}

function Guide() {
  const t = useT();
  return (
    <CardShell>
      <Card>
        <h2 className="text-lg leading-7 font-semibold">
          {t("supportAccessOwner.guide.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("supportAccessOwner.guide.body")}
        </p>
        <dl className="grid">
          <OwnerDetail label={t("supportAccessOwner.guide.auditLabel")}>
            {t("supportAccessOwner.guide.auditValue")}
          </OwnerDetail>
          <OwnerDetail label={t("supportAccessOwner.guide.controlLabel")}>
            {t("supportAccessOwner.guide.controlValue")}
          </OwnerDetail>
        </dl>
      </Card>
    </CardShell>
  );
}

function HistoryItem({
  requesterId,
  requestedAt,
  status,
}: {
  requesterId: string;
  requestedAt: string;
  status: RequestDisplayStatus;
}) {
  const t = useT();
  const tone =
    status === "rejected"
      ? "danger"
      : status === "approved"
        ? "success"
        : "warning";
  const Icon =
    status === "rejected"
      ? CircleSlash
      : status === "approved"
        ? CircleCheck
        : Clock;
  const note = {
    rejected: "supportAccessOwner.history.rejectedNote",
    expired: "supportAccessOwner.history.expiredNote",
    approved: "supportAccessOwner.history.approvedNote",
    pending: "supportAccessOwner.history.approvedNote",
  }[status] as MessageKey;
  return (
    <li className="grid gap-2 border-t-(length:--border-w) py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="text-base font-semibold">
            {t("supportAccessOwner.pending.cardTitle")}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("supportAccessOwner.history.meta", {
              id: shortId(requesterId),
              time: formatInstant(requestedAt),
            })}
          </span>
        </div>
        <Badge tone={tone}>
          <Icon aria-hidden="true" />
          {t(`supportAccessOwner.status.${status}`)}
        </Badge>
      </div>
      <p className="rounded-control bg-surface-2 p-3 text-sm">{t(note)}</p>
    </li>
  );
}

export function OwnerRequestsPage() {
  const t = useT();
  const online = useOnline();
  const clockMs = useSecondClock();
  const guard = useSupportDecisionGuard();
  const requests = useSupportAccessRequests();
  const grants = useOrgGrants();
  const approve = useApproveSupportAccessRequest();
  const reject = useRejectSupportAccessRequest();
  const end = useEndSupportAccess();
  // Shift the device clock to the API clock (see session-banner).
  const skewMs = clockSkewMs(grants.data?.serverNow, grants.dataUpdatedAt);
  const nowMs = clockMs === null ? null : clockMs + skewMs;

  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [failure, setFailure] = React.useState<DecisionErrorKind | null>(null);
  const [revokeFailure, setRevokeFailure] =
    React.useState<DecisionErrorKind | null>(null);
  const [busy, setBusy] = React.useState<{
    id: string;
    kind: "approve" | "reject";
  } | null>(null);

  // The result banner can sit above the fold on a phone (the decided card
  // moves or disappears): bring it into view and focus it.
  const resultRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!notice && !failure) return;
    const el = resultRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  }, [notice, failure]);

  const block = decisionBlock(guard, online);
  const blockedText = block ? t(BLOCK_TEXT[block]) : null;

  const state =
    nowMs === null || requests.isPending || grants.isPending
      ? "loading"
      : requests.isError || grants.isError
        ? "error"
        : "ready";

  const sections = React.useMemo(
    () =>
      sectionRequests(
        requestsFromResult(requests.data),
        grants.data?.data ?? [],
        nowMs ?? 0,
      ),
    [requests.data, grants.data, nowMs],
  );

  const decide = (kind: "approve" | "reject", requestId: string) => {
    setNotice(null);
    setFailure(null);
    setBusy({ id: requestId, kind });
    const mutation = kind === "approve" ? approve : reject;
    mutation.mutate(
      { requestId },
      {
        onSuccess: () =>
          setNotice(kind === "approve" ? "approved" : "rejected"),
        onError: (error) => {
          const kindOfError = decisionErrorKind(error);
          setFailure(kindOfError);
          if (kindOfError === "conflict") void requests.refetch();
        },
        onSettled: () => setBusy(null),
      },
    );
  };

  const revoke = async (grantId: string): Promise<boolean> => {
    setNotice(null);
    setRevokeFailure(null);
    try {
      await end.mutateAsync(grantId);
      setNotice("revoked");
      return true;
    } catch (error) {
      setRevokeFailure(revokeErrorKind(error));
      return false;
    }
  };

  const retry = () => {
    void requests.refetch();
    void grants.refetch();
  };

  const nothingToShow =
    sections.pending.length === 0 && sections.active.length === 0;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {t("supportAccessOwner.description")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      {!online && (
        <Banner
          tone="warning"
          icon={WifiOff}
          title={t("supportAccessOwner.offline.title")}
        >
          {t("supportAccessOwner.offline.body")}
        </Banner>
      )}

      {(notice || failure) && (
        <div
          ref={resultRef}
          tabIndex={-1}
          aria-live="polite"
          className="grid scroll-mt-[calc(var(--support-bar-h,0px)+1rem)] gap-5 outline-none"
        >
          {notice && (
            <Banner
              tone={notice === "rejected" ? "danger" : "success"}
              icon={notice === "rejected" ? CircleSlash : CircleCheck}
              title={t(NOTICE_TEXT[notice].title)}
            >
              {t(NOTICE_TEXT[notice].body)}
            </Banner>
          )}
          {failure && (
            <Banner
              tone="danger"
              icon={TriangleAlert}
              title={t(ERROR_TEXT[failure])}
              role="alert"
            />
          )}
        </div>
      )}

      {state === "loading" && (
        <LoadingBlock label={t("supportAccessOwner.loading")} />
      )}

      {state === "error" && (
        <CardShell>
          <Card>
            {online ? (
              <ErrorState
                error={requests.error ?? grants.error}
                onRetry={retry}
              />
            ) : (
              <ErrorState
                icon={WifiOff}
                title={t("supportAccessOwner.offline.loadFailedTitle")}
                description={t("supportAccessOwner.offline.loadFailedHint")}
                onRetry={retry}
              />
            )}
          </Card>
        </CardShell>
      )}

      {state === "ready" && (
        <>
          {sections.pending.length > 0 && (
            <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:items-start">
              <div className="grid min-w-0 gap-5">
                {sections.pending.map((request) => (
                  <CardShell key={request.id} className="gap-2">
                    <OwnerPendingCard
                      request={request}
                      blockedText={blockedText}
                      busy={busy?.id === request.id ? busy.kind : null}
                      onApprove={(id) => decide("approve", id)}
                      onReject={(id) => decide("reject", id)}
                    />
                  </CardShell>
                ))}
              </div>
              <Guide />
            </div>
          )}

          {sections.active.map((entry) => (
            <CardShell key={entry.grant.id} className="gap-2">
              <OwnerActiveCard
                entry={entry}
                skewMs={skewMs}
                blockedText={blockedText}
                revoking={end.isPending}
                revokeError={
                  revokeFailure ? t(ERROR_TEXT[revokeFailure]) : null
                }
                onRevoke={revoke}
              />
            </CardShell>
          ))}

          {nothingToShow && (
            <CardShell>
              <Card>
                <EmptyState
                  icon={ShieldCheck}
                  title={t("supportAccessOwner.empty.title")}
                  description={t("supportAccessOwner.empty.hint")}
                />
              </Card>
            </CardShell>
          )}

          {sections.history.length > 0 && (
            <CardShell className="gap-2">
              <Card>
                <h2 className="text-lg leading-7 font-semibold">
                  {t("supportAccessOwner.history.title")}
                </h2>
                <ul className="grid">
                  {sections.history.map(({ request, status }) => (
                    <HistoryItem
                      key={request.id}
                      requesterId={request.superAdminUserId}
                      requestedAt={request.requestedAt}
                      status={status}
                    />
                  ))}
                </ul>
              </Card>
            </CardShell>
          )}
        </>
      )}
    </div>
  );
}
