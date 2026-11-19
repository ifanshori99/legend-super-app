// "Hold slip" section of the recon screen: slips that stay held because a recon
// flag could not be written. A hold lifts when a later flag takes it over, or
// when two different people release it on clean evidence. This section only
// proposes and approves that release; it never pays anything, and a slip other
// flags or payout rules hold stays held.
import * as React from "react";
import { Check, Clock, Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { PayoutReconHoldDto } from "@starter/shared/types";
import { isPayoutOffline } from "../errors";
import { usePayoutReconHolds, usePayoutUserNames } from "../hooks";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { HoldApproveForm, HoldProposeForm } from "./recon-hold-forms";
import {
  HOLD_STATUS_META,
  canProposeRelease,
  holdStatus,
  isOwnRelease,
  sortHolds,
  type HoldNotice,
  type HoldStatus,
} from "./recon-hold-model";
import { shortId } from "./recon-model";
import { ReconCallout, ReconTextButton } from "./recon-parts";

const STATUS_ICON = {
  held: Lock,
  proposed: Clock,
  released: Check,
  takenOver: ShieldCheck,
} as const;

export function HoldStatusBadge({ status }: { status: HoldStatus }) {
  const t = useT();
  const meta = HOLD_STATUS_META[status];
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={meta.tone}>
      <Icon aria-hidden="true" />
      {t(meta.labelKey)}
    </Badge>
  );
}

/** "Anda", the person's name, or a distinguishable id when no name is known. */
function useWho(currentUserId: string) {
  const t = useT();
  const names = usePayoutUserNames();
  return (userId: string | null): string => {
    if (!userId) return t("payrollPayoutReview.recon.unknown");
    if (userId === currentUserId) return t("payrollPayoutReview.recon.who.you");
    return (
      names.get(userId) ??
      t("payrollPayoutReview.recon.who.unknown", { id: shortId(userId) })
    );
  };
}

function HoldSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("payrollPayoutReview.reconHold.loading")}
      className="grid gap-3"
    >
      {[0, 1].map((row) => (
        <div
          key={row}
          className="grid gap-2 rounded-container border-(length:--border-w) p-4"
        >
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </div>
  );
}

function HoldCard({
  hold,
  currentUserId,
  who,
  notice,
  onNotice,
}: {
  hold: PayoutReconHoldDto;
  currentUserId: string;
  who: (userId: string | null) => string;
  notice: HoldNotice;
  onNotice: (notice: HoldNotice) => void;
}) {
  const t = useT();
  const causeText = (reason: string | null) => {
    if (reason === null)
      return t("payrollPayoutReview.reconHold.card.causeUnknown");
    if (reason === "evidence_missing")
      return t("payrollPayoutReview.reconHold.card.causeEvidenceMissing");
    if (reason === "evidence_hash_mismatch")
      return t("payrollPayoutReview.reconHold.card.causeEvidenceMismatch");
    if (reason.startsWith("evidence_read_locked"))
      return t("payrollPayoutReview.reconHold.card.causeEvidenceLocked");
    return t("payrollPayoutReview.reconHold.card.causeOther");
  };
  const [proposing, setProposing] = React.useState(false);
  const status = holdStatus(hold);
  const release = hold.release;
  const own = isOwnRelease(hold, currentUserId);
  const mine =
    notice && "holdId" in notice && notice.holdId === hold.id ? notice : null;
  const selfId = `hold-self-${hold.id}`;
  return (
    <li
      data-testid="recon-hold"
      data-status={status}
      className="grid min-w-0 gap-3 rounded-container border-(length:--border-w) bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {t("payrollPayoutReview.reconHold.card.id", {
            id: shortId(hold.id),
          })}
        </p>
        <HoldStatusBadge status={status} />
      </div>
      <div className="grid gap-1 text-sm">
        <p className="tabular text-muted-foreground">
          {t("payrollPayoutReview.reconHold.card.ref", {
            item: shortId(hold.itemId),
            slip: shortId(hold.payslipId),
            batch: shortId(hold.batchId),
          })}
        </p>
        <p className="break-words">
          <span className="text-muted-foreground">
            {t("payrollPayoutReview.reconHold.card.cause")}:{" "}
          </span>
          {causeText(hold.reason)}
        </p>
        <p className="text-xs text-muted-foreground tabular">
          {t("payrollPayoutReview.reconHold.card.heldAt", {
            time: formatDateTime(hold.heldAt),
          })}
        </p>
      </div>

      {mine?.kind === "sent" && (
        <ReconCallout
          tone="success"
          role="status"
          title={t("payrollPayoutReview.reconHold.propose.sent")}
        >
          {t("payrollPayoutReview.reconHold.propose.sentBody")}
        </ReconCallout>
      )}
      {mine?.kind === "released" && (
        <ReconCallout
          tone="success"
          role="status"
          title={t("payrollPayoutReview.reconHold.approve.done")}
        >
          {t("payrollPayoutReview.reconHold.approve.doneBody")}
        </ReconCallout>
      )}

      {status === "takenOver" && (
        <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          {t("payrollPayoutReview.reconHold.card.takenOver")}
        </p>
      )}

      {status === "released" && release && (
        <div className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm">
          <p>
            {t("payrollPayoutReview.reconHold.card.released", {
              proposer: who(release.proposedBy),
              approver: who(release.approvedBy),
              time: formatDateTime(release.approvedAt ?? release.proposedAt),
            })}
          </p>
          <p className="text-muted-foreground">
            {t("payrollPayoutReview.reconHold.card.releasedScope")}
          </p>
        </div>
      )}

      {status === "held" && (
        <>
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("payrollPayoutReview.reconHold.card.held")}
          </p>
          {canProposeRelease(hold) ? (
            proposing ? (
              <HoldProposeForm
                hold={hold}
                onNotice={onNotice}
                onClose={() => setProposing(false)}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full sm:w-fit"
                onClick={() => {
                  onNotice(null);
                  setProposing(true);
                }}
              >
                {t("payrollPayoutReview.reconHold.propose.open")}
              </Button>
            )
          ) : (
            <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
              {t("payrollPayoutReview.reconHold.card.notClean")}
            </p>
          )}
        </>
      )}

      {status === "proposed" && release && (
        <>
          <div className="grid gap-2 rounded-container bg-surface-2 p-3 text-sm">
            <p>
              {t("payrollPayoutReview.reconHold.approve.proposedBy")}{" "}
              <strong>{who(release.proposedBy)}</strong>
              <br />
              <time
                dateTime={release.proposedAt}
                className="text-muted-foreground tabular"
              >
                {formatDateTime(release.proposedAt)}
              </time>
            </p>
            <blockquote className="break-words">{release.reason}</blockquote>
            <p className="text-xs text-muted-foreground">
              {t("payrollPayoutReview.reconHold.approve.reasonCaption")}
            </p>
          </div>
          {own ? (
            <div className="grid gap-3">
              <ReconCallout
                tone="warning"
                title={t("payrollPayoutReview.reconHold.self.title")}
              >
                <span id={selfId}>
                  {t("payrollPayoutReview.reconHold.self.body")}
                </span>
              </ReconCallout>
              <Button
                type="button"
                className="min-h-11 w-full"
                disabled
                aria-describedby={selfId}
              >
                {t("payrollPayoutReview.reconHold.approve.submit")}
              </Button>
            </div>
          ) : (
            <HoldApproveForm key={release.id} hold={hold} onNotice={onNotice} />
          )}
          <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
            {t("payrollPayoutReview.reconHold.approve.note")}
          </p>
        </>
      )}
    </li>
  );
}

export function ReconHoldSection({ currentUserId }: { currentUserId: string }) {
  const t = useT();
  const query = usePayoutReconHolds();
  const who = useWho(currentUserId);
  const [notice, setNotice] = React.useState<HoldNotice>(null);
  const headingId = React.useId();
  const holds = query.data ? sortHolds(query.data) : [];

  return (
    <section
      aria-labelledby={headingId}
      data-testid="recon-hold-section"
      className="grid min-w-0 gap-4 rounded-container border-(length:--border-w) bg-card p-4 sm:p-5"
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="text-lg font-semibold">
            {t("payrollPayoutReview.reconHold.title")}
          </h2>
          {query.data && query.data.length > 0 && (
            <span className="text-sm text-muted-foreground tabular">
              {t("payrollPayoutReview.reconHold.count", {
                count: query.data.length,
              })}
            </span>
          )}
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("payrollPayoutReview.reconHold.subtitle")}
        </p>
      </div>

      {notice?.kind === "stale" && (
        <ReconCallout
          tone="danger"
          role="alert"
          data-testid="recon-hold-conflict"
          title={t("payrollPayoutReview.reconHold.stale.title")}
          action={
            <ReconTextButton onClick={() => setNotice(null)}>
              {t("payrollPayoutReview.reconHold.stale.action")}
            </ReconTextButton>
          }
        >
          {t("payrollPayoutReview.reconHold.stale.body")}
        </ReconCallout>
      )}

      {query.isPending ? (
        <HoldSkeleton />
      ) : query.isError ? (
        <ErrorState
          title={t(
            isPayoutOffline(query.error)
              ? "payrollPayout.error.offlineTitle"
              : "payrollPayoutReview.reconHold.error.title",
          )}
          description={t("payrollPayoutReview.reconHold.error.description")}
          error={query.error}
          action={
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t("payrollPayoutReview.reconHold.error.retry")}
            </Button>
          }
        />
      ) : holds.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={t("payrollPayoutReview.reconHold.empty.title")}
          description={t("payrollPayoutReview.reconHold.empty.description")}
        />
      ) : (
        <ul className="grid gap-3">
          {holds.map((hold) => (
            <HoldCard
              key={hold.id}
              hold={hold}
              currentUserId={currentUserId}
              who={who}
              notice={notice}
              onNotice={setNotice}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
