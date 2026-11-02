// The persistent header of the run wizard (Alur K): the run's state as a
// StatusBand, the facts that identify it, and every action the state allows.
// The action buttons stay visible but disabled with the missing permission
// named (AUTH-05 visible gates); the API still decides.
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Ban,
  Calculator,
  CircleCheck,
  FilePen,
  Lock,
  RotateCcw,
  ShieldCheck,
  Undo2,
  Wallet,
} from "lucide-react";
import type { PayrollRun, PayrollRunStatus } from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { StatusBand, type StatusBandTone } from "@/components/ui/status-band";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import type { PayrollAccess } from "../guard";
import {
  formatBusinessDate,
  formatDateTime,
  RUN_STATUS_LABEL,
  RUN_STEPS,
  runStepState,
  shortId,
  stepAt,
  STEP_HINT,
  STEP_LABEL,
  STEP_STATE_LABEL,
  type RunStepState,
} from "../lib";
import type { RunDialog } from "./run-actions";

const STATUS_ICON: Record<PayrollRunStatus, LucideIcon> = {
  draft: FilePen,
  simulated: Calculator,
  hr_approved: BadgeCheck,
  approved: ShieldCheck,
  locked: Lock,
  paid: CircleCheck,
  reversed: Undo2,
};

const BAND_TONE: Record<PayrollRunStatus, StatusBandTone> = {
  draft: "neutral",
  simulated: "info",
  hr_approved: "warning",
  approved: "info",
  locked: "success",
  paid: "success",
  reversed: "danger",
};

const STEP_STATE_CLASS: Record<RunStepState, string> = {
  done: "bg-success-subtle text-success",
  current: "bg-primary-tint text-primary",
  pending: "bg-surface-3 text-muted-foreground",
  blocked: "bg-danger-subtle text-danger",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm leading-5">{children}</dd>
    </div>
  );
}

function StepRail({ run }: { run: PayrollRun }) {
  const t = useT();
  return (
    <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {RUN_STEPS.map((step, index) => {
        const stepState = runStepState(run, step);
        const at = stepAt(run, step);
        return (
          <li
            key={step}
            data-state={stepState}
            className="flex min-w-0 items-start gap-2.5 rounded-container border-(length:--border-w) bg-card p-3 shadow-hairline"
          >
            <span
              className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular ${STEP_STATE_CLASS[stepState]}`}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="grid min-w-0 gap-0.5">
              <p className="text-sm leading-5 font-semibold">
                {t(STEP_LABEL[step])}
              </p>
              <p className="text-xs leading-4 text-muted-foreground">
                {t(STEP_HINT[step])}
              </p>
              {at && stepState !== "pending" && (
                <p className="text-xs leading-4 text-muted-foreground tabular">
                  {formatDateTime(at)}
                </p>
              )}
              <span className="sr-only">{t(STEP_STATE_LABEL[stepState])}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function RunStatusHeader({
  run,
  access,
  onAction,
}: {
  run: PayrollRun;
  access: PayrollAccess;
  onAction: (dialog: RunDialog) => void;
}) {
  const t = useT();
  const reversed = run.status === "reversed";
  const pendingReversal = run.reversal?.status === "pending";
  const canReturnToDraft =
    access.canRun &&
    (run.status === "simulated" ||
      run.status === "hr_approved" ||
      run.status === "approved");
  const canRequestReversal =
    access.canRun && run.status === "locked" && !pendingReversal;

  const primary: {
    key: RunDialog;
    label: MessageKey;
    icon: LucideIcon;
    allowed: boolean;
    permission: MessageKey;
  } | null =
    run.status === "draft"
      ? {
          key: "simulate",
          label: "payrollRun.action.simulate",
          icon: Calculator,
          allowed: access.canRun,
          permission: "payrollRun.perm.run",
        }
      : run.status === "simulated"
        ? {
            key: "approve_hr",
            label: "payrollRun.action.approveHr",
            icon: BadgeCheck,
            allowed: access.canRun,
            permission: "payrollRun.perm.run",
          }
        : run.status === "hr_approved"
          ? {
              key: "approve_final",
              label: "payrollRun.action.approveFinal",
              icon: ShieldCheck,
              allowed: access.canApprove,
              permission: "payrollRun.perm.approve",
            }
          : run.status === "approved"
            ? {
                key: "lock",
                label: "payrollRun.action.lock",
                icon: Lock,
                allowed: access.canLock,
                permission: "payrollRun.perm.lock",
              }
            : run.status === "locked"
              ? {
                  key: "mark_paid",
                  label: "payrollRun.action.markPaid",
                  icon: Wallet,
                  allowed: access.canLock,
                  permission: "payrollRun.perm.lock",
                }
              : null;
  const PrimaryIcon = primary?.icon;

  return (
    <section
      aria-label={t("payrollRun.detail.headerLabel")}
      className="grid min-w-0 gap-4"
    >
      <div className="min-w-0 overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
        <StatusBand
          tone={BAND_TONE[run.status]}
          icon={STATUS_ICON[run.status]}
          label={t(RUN_STATUS_LABEL[run.status])}
          aside={
            run.totals && (
              <p className="text-sm font-semibold tabular">
                <Money amount={run.totals.netIdr} />
              </p>
            )
          }
        >
          <p className="type-title">
            {t("payrollRun.detail.periodTitle", {
              start: formatBusinessDate(run.periodStart),
              end: formatBusinessDate(run.periodEnd),
            })}
          </p>
          <p className="text-sm leading-5">
            {t("payrollRun.detail.payDate", {
              date: formatBusinessDate(run.payDate),
            })}
          </p>
        </StatusBand>

        <div className="grid gap-4 p-card">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label={t("payrollRun.detail.factRun")}>
              <span className="tabular">{shortId(run.id)}</span>
            </Fact>
            <Fact label={t("payrollRun.detail.factType")}>
              {t(
                run.runType === "regular"
                  ? "payrollRun.runType.regular"
                  : run.runType === "thr"
                    ? "payrollRun.runType.thr"
                    : "payrollRun.runType.offCycle",
              )}
            </Fact>
            <Fact label={t("payrollRun.detail.factPolicy")}>
              <span className="tabular">{shortId(run.payrollPolicyId)}</span>
            </Fact>
            <Fact label={t("payrollRun.detail.factSimulations")}>
              <span className="tabular">{run.simulationCount}</span>
            </Fact>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            {primary && (
              <span className="inline-flex flex-col gap-1">
                <Button
                  type="button"
                  disabled={!primary.allowed}
                  onClick={() => onAction(primary.key)}
                >
                  <PrimaryIcon aria-hidden="true" />
                  {t(primary.label)}
                </Button>
                {!primary.allowed && (
                  <span className="text-xs leading-4 text-muted-foreground">
                    {t("payrollRun.action.needsPermission", {
                      permission: t(primary.permission),
                    })}
                  </span>
                )}
              </span>
            )}
            {run.status === "simulated" && (
              <Button
                type="button"
                variant="outline"
                disabled={!access.canRun}
                onClick={() => onAction("simulate")}
              >
                <RotateCcw aria-hidden="true" />
                {t("payrollRun.action.simulateAgain")}
              </Button>
            )}
            {canReturnToDraft && (
              <Button
                type="button"
                variant="outline"
                onClick={() => onAction("return_to_draft")}
              >
                <Undo2 aria-hidden="true" />
                {t("payrollRun.action.returnToDraft")}
              </Button>
            )}
            {canRequestReversal && (
              <Button
                type="button"
                variant="outline"
                onClick={() => onAction("request_reversal")}
              >
                <Ban aria-hidden="true" />
                {t("payrollRun.action.requestReversal")}
              </Button>
            )}
            {pendingReversal && (
              <Button
                type="button"
                variant="outline"
                disabled={!access.canDecideReversal}
                onClick={() => onAction("decide_reversal")}
              >
                <Undo2 aria-hidden="true" />
                {t("payrollRun.action.decideReversal")}
              </Button>
            )}
            {!primary && !canReturnToDraft && !canRequestReversal && !pendingReversal && (
              <p className="text-sm leading-5 text-muted-foreground">
                {reversed
                  ? t("payrollRun.detail.reversedHint")
                  : t("payrollRun.detail.finishedHint")}
              </p>
            )}
          </div>

          {pendingReversal && (
            <div className="rounded-container border-(length:--border-w) bg-warning-subtle p-3 text-sm leading-5 text-warning">
              <p className="font-semibold">
                {t("payrollRun.detail.pendingReversalTitle")}
              </p>
              <p>
                {t("payrollRun.detail.pendingReversalBody", {
                  reason: run.reversal?.reason ?? "",
                  actor: shortId(run.reversal?.requestedBy ?? ""),
                })}
              </p>
              <p className="mt-1">
                <StatusPill status="warning">
                  {t("payrollRun.reversal.pending")}
                </StatusPill>
              </p>
            </div>
          )}
        </div>
      </div>

      <StepRail run={run} />
    </section>
  );
}
