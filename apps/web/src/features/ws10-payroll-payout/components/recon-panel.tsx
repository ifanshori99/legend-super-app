// Right column of the recon screen: what to do with the chosen flag. Which view
// shows follows the data, not the button last pressed: no proposal → propose;
// a proposal by someone else → approve; my own proposal → wait for a second
// person (the approve button stays off and says why); approved → the record.
// Approving only lifts this flag's hold. It never pays anything.
import * as React from "react";
import { RotateCcw } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import type { PayoutReconFlagDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ReconApproveForm, ReconProposeForm } from "./recon-forms";
import type { ReconFacts } from "./recon-facts";
import {
  isOwnProposal,
  isReopenedNotice,
  reconStatus,
  type ReconNotice,
} from "./recon-model";
import {
  ApprovedBody,
  ChangedNotice,
  OwnWaitingCard,
  PanelNotice,
  ProposalBlock,
} from "./recon-panel-parts";
import { ReconCallout, ReconSelection, ReconTextButton } from "./recon-parts";

function PanelCard({
  step,
  title,
  copy,
  headingRef,
  children,
}: {
  step: string;
  title: string;
  copy?: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      data-testid="recon-panel"
      className="grid min-w-0 gap-4 rounded-container border-(length:--border-w) bg-card p-4 sm:p-5"
    >
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full border-(length:--border-w) text-sm font-semibold"
          >
            {step}
          </span>
          <h2
            id={id}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            {title}
          </h2>
        </div>
        {copy && <p className="text-sm text-muted-foreground">{copy}</p>}
      </div>
      {children}
    </section>
  );
}

export function ReconPanel({
  flag,
  flags,
  facts,
  currentUserId,
  notice,
  focusKey,
  onNotice,
  onSelect,
}: {
  flag: PayoutReconFlagDto;
  /** Flags of the chosen batch; used to point at my own waiting proposal. */
  flags: readonly PayoutReconFlagDto[];
  facts: ReconFacts;
  currentUserId: string;
  notice: ReconNotice;
  /** Above 0 and changing: move focus to the panel heading. */
  focusKey: number;
  onNotice: (notice: ReconNotice) => void;
  onSelect: (flagId: string) => void;
}) {
  const t = useT();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (focusKey > 0) headingRef.current?.focus();
  }, [focusKey]);

  const status = reconStatus(flag);
  const clearance = flag.clearance;
  const own = isOwnProposal(flag, currentUserId);
  // Back to checking: a flag still to review, else any other flag of the batch.
  const firstToReview =
    flags.find((row) => {
      const rowStatus = reconStatus(row);
      return rowStatus === "open" || rowStatus === "reopened";
    }) ?? flags.find((row) => row.id !== flag.id);
  const back = firstToReview ? (
    <ReconTextButton onClick={() => onSelect(firstToReview.id)}>
      {t("payrollPayoutReview.recon.approve.back")}{" "}
      <span aria-hidden="true">→</span>
    </ReconTextButton>
  ) : null;
  const justDone = notice?.kind === "approved" && notice.flagId === flag.id;
  const ownWaiting = flags.find(
    (row) => row.id !== flag.id && isOwnProposal(row, currentUserId),
  );

  const view: { step: string; title: MessageKey; copy?: MessageKey } =
    status === "approved" && clearance
      ? {
          step: "✓",
          title: justDone
            ? "payrollPayoutReview.recon.done.title"
            : "payrollPayoutReview.recon.history.title",
        }
      : status === "proposed" && clearance
        ? {
            step: "2",
            title: "payrollPayoutReview.recon.approve.title",
            copy: "payrollPayoutReview.recon.approve.copy",
          }
        : {
            step: "1",
            title: "payrollPayoutReview.recon.propose.title",
            copy: "payrollPayoutReview.recon.propose.copy",
          };

  return (
    <div className="grid gap-4">
      <ChangedNotice notice={notice} onNotice={onNotice} />
      <PanelCard
        step={view.step}
        title={t(view.title)}
        copy={view.copy ? t(view.copy) : undefined}
        headingRef={headingRef}
      >
        <PanelNotice flag={flag} facts={facts} notice={notice} />
        <ReconSelection flag={flag} facts={facts} />
        {status === "approved" && clearance ? (
          <>
            <ApprovedBody flag={flag} facts={facts} justDone={justDone} />
            {back}
          </>
        ) : status === "proposed" && clearance ? (
          <>
            {isReopenedNotice(flag) && (
              <ReconCallout
                tone="warning"
                icon={RotateCcw}
                title={t("payrollPayoutReview.recon.approve.reopenedTitle")}
              >
                {t("payrollPayoutReview.recon.approve.reopenedBody")}
              </ReconCallout>
            )}
            <ProposalBlock flag={flag} facts={facts} />
            {own ? (
              <div className="grid gap-3">
                <ReconCallout
                  tone="warning"
                  title={t("payrollPayoutReview.recon.self.title")}
                >
                  <span id="recon-self-reason">
                    {t("payrollPayoutReview.recon.self.body")}
                  </span>
                </ReconCallout>
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  disabled
                  aria-describedby="recon-self-reason"
                >
                  {t("payrollPayoutReview.recon.approve.submit")}
                </Button>
              </div>
            ) : (
              <ReconApproveForm
                key={clearance.id}
                flag={flag}
                onNotice={onNotice}
              />
            )}
            <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
              {t("payrollPayoutReview.recon.approve.note")}
            </p>
            {back}
          </>
        ) : (
          <>
            {isReopenedNotice(flag) && (
              <ReconCallout
                tone="warning"
                icon={RotateCcw}
                title={t("payrollPayoutReview.recon.propose.reopenedTitle")}
              >
                {t("payrollPayoutReview.recon.propose.reopenedBody")}
              </ReconCallout>
            )}
            <ReconProposeForm key={flag.id} flag={flag} onNotice={onNotice} />
          </>
        )}
      </PanelCard>
      {status !== "approved" && status !== "proposed" && ownWaiting && (
        <OwnWaitingCard flag={ownWaiting} facts={facts} onSelect={onSelect} />
      )}
    </div>
  );
}
