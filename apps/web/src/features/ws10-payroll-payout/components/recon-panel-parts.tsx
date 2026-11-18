// Blocks of the recon panel: the proposal under review, the last write's
// result, the approved record, and the pointer to my own waiting proposal.
import type { PayoutReconFlagDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import type { ReconFacts } from "./recon-facts";
import { itemOfFlag, shortId, type ReconNotice } from "./recon-model";
import { ReconCallout, ReconTextButton, reconName } from "./recon-parts";

export function ProposalBlock({
  flag,
  facts,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
}) {
  const t = useT();
  const clearance = flag.clearance;
  if (!clearance) return null;
  return (
    <div className="grid gap-2 rounded-container bg-surface-2 p-3 text-sm">
      <p>
        {t("payrollPayoutReview.recon.approve.proposedBy")}{" "}
        <strong>{facts.who(clearance.proposedBy, t)}</strong>
        <br />
        <time
          dateTime={clearance.proposedAt}
          className="text-muted-foreground tabular"
        >
          {formatDateTime(clearance.proposedAt)}
        </time>
      </p>
      <blockquote className="break-words">{clearance.reason}</blockquote>
      <p className="text-xs text-muted-foreground">
        {t("payrollPayoutReview.recon.approve.reasonCaption")}
      </p>
    </div>
  );
}

export function ChangedNotice({
  notice,
  onNotice,
}: {
  notice: ReconNotice;
  onNotice: (notice: ReconNotice) => void;
}) {
  const t = useT();
  if (notice?.kind !== "changed" && notice?.kind !== "stale") return null;
  const changed = notice.kind === "changed";
  return (
    <ReconCallout
      tone="danger"
      role="alert"
      data-testid="recon-conflict"
      title={t(
        changed
          ? "payrollPayoutReview.recon.changed.title"
          : "payrollPayoutReview.recon.changed.staleTitle",
      )}
      action={
        <Button
          type="button"
          variant="outline"
          className="min-h-11 border-foreground/50"
          onClick={() => {
            onNotice(null);
            // The reason field exists again once the notice is gone.
            if (changed)
              requestAnimationFrame(() =>
                document.getElementById("recon-reason")?.focus(),
              );
          }}
        >
          {t(
            changed
              ? "payrollPayoutReview.recon.changed.action"
              : "payrollPayoutReview.recon.changed.staleAction",
          )}
        </Button>
      }
    >
      {t(
        changed
          ? "payrollPayoutReview.recon.changed.body"
          : "payrollPayoutReview.recon.changed.staleBody",
      )}
    </ReconCallout>
  );
}

/** Result of the last write on this flag, announced where the person is looking. */
export function PanelNotice({
  flag,
  facts,
  notice,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
  notice: ReconNotice;
}) {
  const t = useT();
  if (!notice || !("flagId" in notice) || notice.flagId !== flag.id)
    return null;
  if (notice.kind === "sent")
    return (
      <ReconCallout
        tone="success"
        role="status"
        title={t("payrollPayoutReview.recon.propose.sent")}
      >
        {t("payrollPayoutReview.recon.propose.sentBody")}
      </ReconCallout>
    );
  const clearance = flag.clearance;
  if (notice.kind !== "approved" || clearance?.status !== "approved")
    return null;
  return (
    <ReconCallout
      tone="success"
      role="status"
      title={t("payrollPayoutReview.recon.done.banner")}
    >
      {t("payrollPayoutReview.recon.done.bannerBody", {
        proposer: facts.who(clearance.proposedBy, t),
        approver: facts.who(clearance.approvedBy, t),
        time: clearance.approvedAt
          ? formatDateTime(clearance.approvedAt)
          : t("payrollPayoutReview.recon.unknown"),
        id: shortId(flag.id),
      })}
    </ReconCallout>
  );
}

export function ApprovedBody({
  flag,
  facts,
  justDone,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
  justDone: boolean;
}) {
  const t = useT();
  const clearance = flag.clearance;
  if (!clearance) return null;
  const proposer = facts.who(clearance.proposedBy, t);
  const approver = facts.who(clearance.approvedBy, t);
  if (justDone)
    return (
      <>
        <p className="text-sm">
          {t("payrollPayoutReview.recon.done.by", { approver, proposer })}
        </p>
        <ReconCallout
          tone="success"
          title={t("payrollPayoutReview.recon.done.closedTitle")}
        >
          {t("payrollPayoutReview.recon.done.closedBody")}
        </ReconCallout>
        <p className="text-sm text-muted-foreground">
          {t("payrollPayoutReview.recon.done.note")}
        </p>
      </>
    );
  return (
    <>
      <div className="grid gap-2 rounded-container bg-surface-2 p-3 text-sm">
        <p>
          <strong>
            {t("payrollPayoutReview.recon.history.proposer", {
              name: proposer,
            })}
          </strong>
          <br />
          <time className="tabular">
            {formatDateTime(clearance.proposedAt)}
          </time>
        </p>
        <blockquote className="break-words">{clearance.reason}</blockquote>
        <p>
          <strong>
            {t("payrollPayoutReview.recon.history.approver", {
              name: approver,
            })}
          </strong>
          <br />
          <time className="tabular">
            {clearance.approvedAt
              ? formatDateTime(clearance.approvedAt)
              : t("payrollPayoutReview.recon.unknown")}
          </time>
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("payrollPayoutReview.recon.history.note")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("payrollPayoutReview.recon.history.scope")}
      </p>
    </>
  );
}

export function OwnWaitingCard({
  flag,
  facts,
  onSelect,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
  onSelect: (flagId: string) => void;
}) {
  const t = useT();
  const item = itemOfFlag(facts.items, flag);
  const name = item ? facts.employeeName(item) : null;
  if (!flag.clearance) return null;
  return (
    <section
      aria-label={t("payrollPayoutReview.recon.self.noteTitle")}
      className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-4 text-sm"
    >
      <h3 className="font-semibold">
        {t("payrollPayoutReview.recon.self.noteTitle")}
      </h3>
      <p>
        <strong>{reconName(name, facts, t)}</strong>
        {" · "}
        {t("payrollPayoutReview.recon.flag.id", { id: shortId(flag.id) })}
        <br />
        {t("payrollPayoutReview.recon.self.noteBody", {
          time: formatDateTime(flag.clearance.proposedAt),
        })}
      </p>
      <Button
        type="button"
        className="min-h-11"
        disabled
        aria-describedby="recon-own-explain"
      >
        {t("payrollPayoutReview.recon.approve.submit")}
      </Button>
      <p id="recon-own-explain" className="text-muted-foreground">
        {t("payrollPayoutReview.recon.self.explain")}
      </p>
      <ReconTextButton onClick={() => onSelect(flag.id)}>
        {t("payrollPayoutReview.recon.self.detail")}{" "}
        <span aria-hidden="true">→</span>
      </ReconTextButton>
    </section>
  );
}
