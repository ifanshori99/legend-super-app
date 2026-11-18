// Left column of the recon screen: one card per flag of the chosen batch. The
// card shows the finance reason, who and how much (joined from the batch), the
// status in words, and whether the flag still holds the payslip.
import {
  Check,
  CircleDot,
  Clock,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import type { PayoutReconFlagDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import type { ReconFacts } from "./recon-facts";
import { reconName } from "./recon-parts";
import {
  RECON_STATUS_META,
  isHeld,
  isReopenedNotice,
  itemOfFlag,
  reconStatus,
  shortId,
  type ReconStatus,
} from "./recon-model";

const STATUS_ICON = {
  open: TriangleAlert,
  proposed: Clock,
  approved: Check,
  reopened: RotateCcw,
} as const;

export function ReconStatusBadge({ status }: { status: ReconStatus }) {
  const t = useT();
  const meta = RECON_STATUS_META[status];
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={meta.tone}>
      <Icon aria-hidden="true" />
      {t(meta.labelKey)}
    </Badge>
  );
}

/** Employee, item reference and amounts of one flag, as far as the batch tells. */
export function ReconFlagWho({
  flag,
  facts,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
}) {
  const t = useT();
  const item = itemOfFlag(facts.items, flag);
  const name = item ? facts.employeeName(item) : null;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold break-words">
          {reconName(name, facts, t)}
        </p>
        <p className="text-xs text-muted-foreground tabular">
          {t("payrollPayoutReview.recon.flag.ref", {
            item: shortId(flag.itemId),
            slip: shortId(flag.payslipId),
          })}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {item ? (
          <>
            <Money amount={item.amountIdr} size="lg" />
            <p className="text-xs text-muted-foreground tabular">
              {t("payrollPayoutReview.recon.flag.fee", {
                fee: formatRupiah(item.feeIdr),
              })}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {facts.batchState === "loading"
              ? t("payrollPayout.common.loading")
              : t("payrollPayoutReview.recon.flag.noDetail")}
          </p>
        )}
      </div>
    </div>
  );
}

export function ReconFlagList({
  flags,
  selectedId,
  facts,
  truncated,
  onSelect,
}: {
  flags: readonly PayoutReconFlagDto[];
  selectedId: string | undefined;
  facts: ReconFacts;
  /** The API list hit its cap (all batches), so older flags may be missing. */
  truncated: boolean;
  onSelect: (flagId: string) => void;
}) {
  const t = useT();
  return (
    <section
      aria-labelledby="recon-list-title"
      className="min-w-0 rounded-container border-(length:--border-w) bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="recon-list-title" className="text-lg font-semibold">
            {t("payrollPayoutReview.recon.list.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("payrollPayoutReview.recon.list.hint")}
          </p>
        </div>
        <span className="text-sm text-muted-foreground tabular">
          {t("payrollPayoutReview.recon.list.count", { count: flags.length })}
        </span>
      </div>
      {truncated && (
        <p
          role="note"
          className="mt-3 rounded-container bg-warning-subtle p-3 text-sm"
        >
          {t("payrollPayoutReview.recon.list.limit")}
        </p>
      )}
      <ul className="mt-3 grid">
        {flags.map((flag) => (
          <ReconFlagCard
            key={flag.id}
            flag={flag}
            facts={facts}
            selected={flag.id === selectedId}
            onSelect={() => onSelect(flag.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function ReconFlagCard({
  flag,
  facts,
  selected,
  onSelect,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const status = reconStatus(flag);
  const clearance = flag.clearance;
  const actionKey =
    status === "approved"
      ? "payrollPayoutReview.recon.flag.viewApproval"
      : status === "proposed"
        ? "payrollPayoutReview.recon.flag.viewProposal"
        : "payrollPayoutReview.recon.flag.review";
  return (
    <li
      data-testid="recon-flag"
      data-flag-id={flag.id}
      data-status={status}
      className={cn(
        // The accent is the left edge only; the divider keeps its own colour.
        "grid gap-2 border-t border-l-4 border-t-border py-4 pl-3 first:border-t-0 first:pt-2",
        selected ? "border-l-primary" : "border-l-transparent",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground tabular">
          {t("payrollPayoutReview.recon.flag.id", { id: shortId(flag.id) })}
        </span>
        <ReconStatusBadge status={status} />
      </div>
      <h3 className="text-base leading-6 font-semibold break-words">
        {flag.reason}
      </h3>
      <ReconFlagWho flag={flag} facts={facts} />
      <p
        className={cn(
          "flex items-center gap-1.5 text-sm font-medium",
          isHeld(flag) ? "text-warning" : "text-success",
        )}
      >
        {isHeld(flag) ? (
          <CircleDot className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <Check className="size-4 shrink-0" aria-hidden="true" />
        )}
        {t(
          isHeld(flag)
            ? "payrollPayoutReview.recon.flag.held"
            : "payrollPayoutReview.recon.flag.released",
        )}
      </p>
      {isReopenedNotice(flag) && (
        <div className="text-sm">
          <p className="flex items-center gap-1.5 font-semibold">
            <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
            {t("payrollPayoutReview.recon.flag.reopened")}
          </p>
          <p className="text-muted-foreground">
            {t("payrollPayoutReview.recon.flag.reopenedHint")}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <p className="min-w-0 text-xs text-muted-foreground tabular">
          {clearance?.status === "approved"
            ? t("payrollPayoutReview.recon.flag.approvedBy", {
                proposer: facts.who(clearance.proposedBy, t),
                approver: facts.who(clearance.approvedBy, t),
                time: clearance.approvedAt
                  ? formatDateTime(clearance.approvedAt)
                  : t("payrollPayoutReview.recon.unknown"),
              })
            : clearance
              ? t("payrollPayoutReview.recon.flag.proposedBy", {
                  name: facts.who(clearance.proposedBy, t),
                  time: formatDateTime(clearance.proposedAt),
                })
              : t("payrollPayoutReview.recon.flag.flaggedAt", {
                  time: formatDateTime(flag.flaggedAt),
                })}
        </p>
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          className="inline-flex min-h-11 items-center px-1 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t(actionKey)} <span aria-hidden="true">→</span>
          <span className="sr-only">
            {" "}
            {t("payrollPayoutReview.recon.flag.id", { id: shortId(flag.id) })}
          </span>
        </button>
      </div>
    </li>
  );
}
