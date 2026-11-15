// Two-person order of a payout: who asked, and the different person who
// approves. The batch carries user ids; names come from the employee list, with "Anda" or "Orang lain" as fallback.
import { Check, Clock } from "lucide-react";
import type { PayrollDisbursementBatchDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { cn } from "cn";
import { formatDateTime } from "../../ws10-payroll-run/lib";

function StepCard({
  label,
  who,
  time,
  stateLabel,
  done,
  dashed = false,
}: {
  label: string;
  who: string;
  time: string | null;
  stateLabel: string;
  done: boolean;
  dashed?: boolean;
}) {
  const Icon = done ? Check : Clock;
  return (
    <li
      className={cn(
        "grid content-start gap-1.5 rounded-container border-(length:--border-w) p-4",
        dashed ? "border-dashed bg-card" : "bg-surface-2",
      )}
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-base font-semibold">{who}</p>
      {time && <p className="text-sm text-muted-foreground">{time}</p>}
      <p
        className={cn(
          "mt-2 flex min-h-10 w-full items-center gap-2 rounded-control px-3 py-2 text-sm font-semibold",
          done
            ? "bg-success-subtle text-success"
            : "bg-warning-subtle text-warning",
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
        {stateLabel}
      </p>
    </li>
  );
}

export function ApprovalSteps({
  batch,
  currentUserId,
  userNames,
}: {
  batch: PayrollDisbursementBatchDto;
  currentUserId: string;
  /** Login user id → employee name; a missing id falls back to a role word. */
  userNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const who = (userId: string) => {
    const name = userNames.get(userId);
    if (userId === currentUserId)
      return name
        ? `${t("payrollPayoutReview.common.you")} · ${name}`
        : t("payrollPayoutReview.common.you");
    return name ?? t("payrollPayoutReview.common.someoneElse");
  };
  const approved = batch.approvedBy !== null;
  return (
    <ol
      aria-label={t("payrollPayoutReview.approval.step.progress", {
        done: approved ? 2 : 1,
      })}
      className="grid gap-3 min-[700px]:grid-cols-2"
    >
      <StepCard
        label={t("payrollPayoutReview.approval.step.creator")}
        who={who(batch.requestedBy)}
        time={t("payrollPayoutReview.approval.step.requestedAt", {
          time: formatDateTime(batch.requestedAt),
        })}
        stateLabel={t("payrollPayoutReview.approval.step.requested")}
        done
      />
      <StepCard
        dashed={!approved}
        label={t("payrollPayoutReview.approval.step.approver")}
        who={
          batch.approvedBy
            ? who(batch.approvedBy)
            : t("payrollPayoutReview.approval.step.approverHint")
        }
        time={
          batch.approvedAt
            ? t("payrollPayoutReview.approval.step.approvedAt", {
                time: formatDateTime(batch.approvedAt),
              })
            : null
        }
        stateLabel={t(
          approved
            ? "payrollPayoutReview.approval.step.approved"
            : "payrollPayoutReview.approval.step.waiting",
        )}
        done={approved}
      />
    </ol>
  );
}
