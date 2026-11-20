// The distribution wizard (PRD §3.37 "Siklus Distribusi", §4 "Alur P"):
// 1 hitung → 2 simulasi → 3 persetujuan → 4 pembayaran → 5 pernyataan.
//
// The page keeps the run id, and the visible step is derived from the loaded
// run's status (../lib.ts distributionWizardStep), so closing the dialog and
// reopening the same run resumes where it is instead of starting over. SH-04:
// an approved run is locked — the only correction is an adjustment distribution
// with a reversing journal.
import * as React from "react";
import {
  ArrowRight,
  CircleCheck,
  Lock,
  PlusCircle,
  ReceiptText,
  Send,
  ShieldCheck,
  Wallet,
  XCircle,
} from "lucide-react";
import { cn } from "cn";
import type {
  DistributionRun,
  FiscalPeriod,
  ProfitEntity,
  Shareholder,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { formatRupiah } from "@starter/shared/i18n";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ReasonDialog } from "@/features/ws07-accounting/components/reason-dialog";
import { useFiscalPeriods } from "@/features/ws07-accounting/hooks";
import { useCanApproveShareAllocation } from "../guard";
import {
  useCancelApprovedDistributionRun,
  useCreateDistributionRun,
  useDecideDistributionRun,
  useDistributionRun,
  useDistributionStatement,
  useRecordDistributionPayment,
  useShareholders,
  useSubmitDistributionRun,
} from "../hooks";
import {
  DISTRIBUTION_WIZARD_STEPS,
  FREQUENCY_KEYS,
  basisKey,
  canCancelApprovedRun,
  canRecordPayments,
  CANCEL_APPROVED_REASON_MIN,
  distributionProgress,
  distributionWizardStep,
  distributionWizardStepIndex,
  formatShareBp,
  formatShareBpInteger,
  formatShareDateTime,
  formatSharePeriod,
  isClosedPeriod,
  isCarryAbsorbedLine,
  isDistributionLocked,
  shortActorRef,
} from "../lib";
import { PaymentStatusBadge, RunStatusBadge } from "./share-status";

const STEP_KEYS = {
  calculate: "accounting.share.wizard.step.calculate",
  simulate: "accounting.share.wizard.step.simulate",
  approval: "accounting.share.wizard.step.approval",
  payment: "accounting.share.wizard.step.payment",
  statement: "accounting.share.wizard.step.statement",
} as const;

export function DistributionWizardDialog({
  open,
  onOpenChange,
  legalEntityId,
  profitEntity,
  runId,
  onRunChange,
  onAdjust,
  startCancel = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  profitEntity: ProfitEntity;
  /** null = a new distribution (step 1). */
  runId: string | null;
  onRunChange: (distributionRunId: string | null) => void;
  /** Opens the SH-04 adjustment dialog for a locked run. */
  onAdjust: (run: DistributionRun) => void;
  /** Opens the "Batalkan persetujuan" dialog as soon as the run loads. */
  startCancel?: boolean;
}) {
  // Radix unmounts DialogContent on close, so the wizard re-seeds on opening.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <WizardBody
          onOpenChange={onOpenChange}
          legalEntityId={legalEntityId}
          profitEntity={profitEntity}
          runId={runId}
          onRunChange={onRunChange}
          onAdjust={onAdjust}
          startCancel={startCancel}
        />
      </DialogContent>
    </Dialog>
  );
}

function WizardBody({
  onOpenChange,
  legalEntityId,
  profitEntity,
  runId,
  onRunChange,
  onAdjust,
  startCancel,
}: {
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  profitEntity: ProfitEntity;
  runId: string | null;
  onRunChange: (distributionRunId: string | null) => void;
  onAdjust: (run: DistributionRun) => void;
  startCancel: boolean;
}) {
  const t = useT();
  const runQuery = useDistributionRun(runId ?? undefined);
  const shareholdersQuery = useShareholders();
  const shareholders = shareholdersQuery.data ?? [];
  const run = runId ? runQuery.data : null;
  const step = distributionWizardStep(run ?? null);
  const stepIndex = distributionWizardStepIndex(step);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {run
            ? t("accounting.share.wizard.titleRun", {
                period: formatSharePeriod(run.period),
              })
            : t("accounting.share.wizard.titleCreate")}
        </DialogTitle>
        <DialogDescription>
          {t("accounting.share.wizard.description")}
        </DialogDescription>
      </DialogHeader>

      <StepIndicator current={stepIndex} />

      {runId && runQuery.isPending && (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">
            {t("accounting.share.wizard.loading")}
          </span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-row w-full" />
          <Skeleton className="h-row w-full" />
          <Skeleton className="h-row w-full" />
        </div>
      )}

      {runId && runQuery.isError && (
        <ErrorState
          onRetry={() => {
            void runQuery.refetch();
          }}
        />
      )}

      {run && <RunMeta run={run} />}

      {!runId && (
        <CalculateStep
          legalEntityId={legalEntityId}
          profitEntity={profitEntity}
          onCalculated={(created) => onRunChange(created.id)}
        />
      )}

      {run && step === "simulate" && (
        <SimulationStep run={run} shareholders={shareholders} />
      )}

      {run && step === "approval" && (
        <ApprovalStep run={run} onNewRun={() => onRunChange(null)} />
      )}

      {run && step === "payment" && (
        <PaymentStep
          run={run}
          shareholders={shareholders}
          onAdjust={() => onAdjust(run)}
          startCancel={startCancel}
        />
      )}

      {run && step === "statement" && (
        <StatementStep
          run={run}
          shareholders={shareholders}
          onAdjust={() => onAdjust(run)}
        />
      )}

      <DialogFooter>
        {run && run.type === "adjustment" && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onRunChange(null)}
          >
            <PlusCircle aria-hidden="true" />
            {t("accounting.share.runs.new")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          {t("accounting.share.wizard.close")}
        </Button>
      </DialogFooter>
    </>
  );
}

function StepIndicator({ current }: { current: number }) {
  const t = useT();
  return (
    <ol
      aria-label={t("accounting.share.wizard.stepsLabel")}
      className="flex flex-wrap gap-1.5"
    >
      {DISTRIBUTION_WIZARD_STEPS.map((step, index) => {
        const position = index + 1;
        const state =
          position < current
            ? "done"
            : position === current
              ? "current"
              : "next";
        return (
          <li
            key={step}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full border-(length:--border-w) px-2.5 py-1 text-xs font-semibold",
              state === "current" &&
                "border-transparent bg-primary text-primary-foreground",
              state === "done" &&
                "border-transparent bg-success-subtle text-success",
              state === "next" &&
                "border-border bg-surface-2 text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full tabular",
                state === "current" && "bg-primary-foreground/15",
                state === "done" && "bg-success/15",
                state === "next" && "bg-surface-3",
              )}
            >
              {position}
            </span>
            {t(STEP_KEYS[step])}
            <span className="sr-only">
              {t(
                state === "current"
                  ? "accounting.share.wizard.stepState.current"
                  : state === "done"
                    ? "accounting.share.wizard.stepState.done"
                    : "accounting.share.wizard.stepState.next",
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RunMeta({ run }: { run: DistributionRun }) {
  const t = useT();
  return (
    <dl className="grid gap-3 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm sm:grid-cols-2">
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t("accounting.share.wizard.runMeta.status")}
        </dt>
        <dd>
          <RunStatusBadge status={run.status} />
        </dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t("accounting.share.wizard.runMeta.type")}
        </dt>
        <dd className="font-medium">
          {t(
            run.type === "adjustment"
              ? "accounting.share.runType.adjustment"
              : "accounting.share.runType.regular",
          )}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t("accounting.share.wizard.runMeta.period")}
        </dt>
        <dd className="font-medium">{formatSharePeriod(run.period)}</dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t("accounting.share.wizard.runMeta.total")}
        </dt>
        <dd className="font-medium">
          <Money amount={run.distributableIdr} />
        </dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">
          {t("accounting.share.wizard.runMeta.shareVersion", {
            version: run.shareVersion,
          })}
        </dt>
        <dd className="tabular text-muted-foreground">
          {t("accounting.share.wizard.runMeta.requested", {
            ref: shortActorRef(run.requestedBy),
            date: formatShareDateTime(run.requestedAt),
          })}
        </dd>
      </div>
      {run.approvedAt && run.approvedBy && (
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("accounting.share.wizard.runMeta.approvedLabel")}
          </dt>
          <dd className="tabular text-muted-foreground">
            {t("accounting.share.wizard.runMeta.approvedBy", {
              ref: shortActorRef(run.approvedBy),
              date: formatShareDateTime(run.approvedAt),
            })}
          </dd>
        </div>
      )}
      {run.adjustsRunId && (
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("accounting.share.wizard.adjustTarget", {
              period: formatSharePeriod(run.period),
            })}
          </dt>
          <dd className="tabular">{shortActorRef(run.adjustsRunId)}</dd>
        </div>
      )}
      {run.reversalJournalEntryId && (
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("accounting.share.wizard.adjustReversal")}
          </dt>
          <dd className="tabular">
            {shortActorRef(run.reversalJournalEntryId)}
          </dd>
        </div>
      )}
    </dl>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
    >
      {message}
    </p>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

// ---- 1. Hitung ------------------------------------------------------------

function CalculateStep({
  legalEntityId,
  profitEntity,
  onCalculated,
}: {
  legalEntityId: string;
  profitEntity: ProfitEntity;
  onCalculated: (run: DistributionRun) => void;
}) {
  const t = useT();
  const periodsQuery = useFiscalPeriods(legalEntityId);
  const create = useCreateDistributionRun(profitEntity.id);
  const [periodId, setPeriodId] = React.useState<string>("");
  const periodFieldId = React.useId();
  const [error, setError] = React.useState<string | null>(null);

  const periods = periodsQuery.data ?? [];
  const closed = periods.filter((row) => isClosedPeriod(row.status));
  const selected: FiscalPeriod | undefined =
    periods.find((row) => row.id === periodId) ?? closed[0] ?? periods[0];
  const isOpen = selected ? !isClosedPeriod(selected.status) : false;

  const submit = async () => {
    if (!selected) return;
    setError(null);
    try {
      const run = await create.mutateAsync({
        fiscalPeriodId: selected.id,
      });
      onCalculated(run);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  if (periodsQuery.isPending)
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-control w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (periodsQuery.isError)
    return (
      <ErrorState
        onRetry={() => {
          void periodsQuery.refetch();
        }}
      />
    );

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("accounting.share.wizard.calc.title")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.share.wizard.calc.description")}
        </p>
      </div>
      {periods.length === 0 ? (
        <EmptyState
          title={t("accounting.share.wizard.calc.noPeriods")}
          description={t("accounting.share.wizard.calc.periodHint")}
        />
      ) : (
        <>
          <FormField
            id={periodFieldId}
            label={t("accounting.share.wizard.calc.period")}
            hint={t("accounting.share.wizard.calc.periodHint")}
            required
          >
            <Select
              value={selected?.id ?? ""}
              onValueChange={(value) => {
                setPeriodId(value);
                setError(null);
              }}
            >
              <SelectTrigger id={periodFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((period) => (
                  <SelectItem key={period.id} value={period.id}>
                    {formatSharePeriod(period.period)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <dl className="grid gap-2 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("accounting.share.wizard.calc.basis")}
              </dt>
              <dd className="font-medium">
                {t(basisKey(profitEntity.policy))}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("accounting.share.policy.frequency")}
              </dt>
              <dd className="font-medium">
                {t(FREQUENCY_KEYS[profitEntity.policy.frequency])}
              </dd>
            </div>
          </dl>
          {isOpen && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border-(length:--border-w) border-warning bg-warning-subtle p-3 text-sm text-foreground">
              <StatusPill status="warning">
                {t("accounting.share.wizard.calc.estimateBadge")}
              </StatusPill>
              <p>{t("accounting.share.wizard.calc.openWarning")}</p>
            </div>
          )}
          {error && <InlineError message={error} />}
          <div className="flex justify-end">
            <Button
              type="button"
              loading={create.isPending}
              disabled={!selected || isOpen || create.isPending}
              onClick={() => void submit()}
            >
              <ArrowRight aria-hidden="true" />
              {t("accounting.share.wizard.calc.submit")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- 2. Simulasi ----------------------------------------------------------

function SimulationStep({
  run,
  shareholders,
}: {
  run: DistributionRun;
  shareholders: readonly Shareholder[];
}) {
  const t = useT();
  const toast = useToast();
  const submit = useSubmitDistributionRun(run.profitEntityId);
  const [error, setError] = React.useState<string | null>(null);
  const byId = React.useMemo(
    () => new Map(shareholders.map((row) => [row.id, row])),
    [shareholders],
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("accounting.share.wizard.sim.title")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {run.type === "adjustment"
            ? t("accounting.share.wizard.sim.adjustmentNote")
            : t("accounting.share.wizard.calc.periodHint")}
        </p>
      </div>
      <dl className="grid gap-2 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm sm:grid-cols-2">
        {run.periodNetProfitIdr !== null && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.share.wizard.sim.netProfit")}
            </dt>
            <dd className="font-medium">
              <Money amount={run.periodNetProfitIdr} />
            </dd>
          </div>
        )}
        {run.type === "regular" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.share.wizard.sim.reserve")}
            </dt>
            <dd className="font-medium">
              <Money amount={run.reserveIdr} />
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("accounting.share.wizard.sim.distributable")}
          </dt>
          <dd className="font-medium">
            <Money amount={run.distributableIdr} />
          </dd>
        </div>
        {run.carryDeductedIdr > 0 && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("accounting.share.wizard.sim.carryDeducted")}
            </dt>
            <dd className="font-medium">
              <Money amount={run.carryDeductedIdr} />
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("accounting.share.wizard.sim.tax")}
          </dt>
          <dd className="font-medium">
            <Money amount={run.totalTaxWithheldIdr} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("accounting.share.wizard.sim.totalNet")}
          </dt>
          <dd className="font-semibold">
            <Money amount={run.totalNetIdr} />
          </dd>
        </div>
      </dl>
      <Table className="min-w-[36rem]">
        <TableHeader>
          <TableRow>
            <TableHead>
              {t("accounting.share.wizard.sim.columns.shareholder")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.share.wizard.sim.columns.share")}
            </TableHead>
            {run.carryDeductedIdr > 0 && (
              <TableHead numeric>
                {t("accounting.share.wizard.sim.columns.carry")}
              </TableHead>
            )}
            <TableHead numeric>
              {t("accounting.share.wizard.sim.columns.gross")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.share.wizard.sim.columns.tax")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.share.wizard.sim.columns.net")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {run.lines.map((line) => (
            <TableRow key={line.id}>
              <TableCell className="font-medium">
                {byId.get(line.shareholderId)?.name ??
                  t("accounting.share.allocations.unknown")}
                {isCarryAbsorbedLine(line) && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t("accounting.share.wizard.sim.zeroLine")}
                  </span>
                )}
              </TableCell>
              <TableCell numeric className="tabular">
                {formatShareBp(line.shareBp)}
              </TableCell>
              {run.carryDeductedIdr > 0 && (
                <TableCell numeric className="text-muted-foreground">
                  <Money amount={line.carryDeductedIdr} />
                </TableCell>
              )}
              <TableCell numeric>
                <Money amount={line.grossIdr} />
              </TableCell>
              <TableCell numeric className="text-muted-foreground">
                <Money amount={line.taxWithheldIdr} />
              </TableCell>
              <TableCell numeric className="font-semibold">
                <Money amount={line.netIdr} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {run.carryDeductions.length > 0 && (
        <div className="grid gap-1 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm">
          <p className="text-muted-foreground">
            {t("accounting.share.wizard.sim.carryHint")}
          </p>
          <ul className="grid gap-1">
            {run.carryDeductions.map((row) => (
              <li
                key={`${row.shareholderId}:${row.shortfallRunId}`}
                className="flex items-center justify-between gap-2"
              >
                <span>
                  {byId.get(row.shareholderId)?.name ??
                    t("accounting.share.allocations.unknown")}
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("accounting.share.wizard.sim.carryFrom", {
                      ref: shortActorRef(row.shortfallRunId),
                    })}
                  </span>
                </span>
                <span className="font-medium">
                  <Money amount={row.amountIdr} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <InlineError message={error} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          loading={submit.isPending}
          onClick={() => {
            setError(null);
            submit
              .mutateAsync(run.id)
              .then(() =>
                toast({ title: t("accounting.share.wizard.sim.submitted") }),
              )
              .catch((caught) => setError(errorMessage(caught)));
          }}
        >
          <Send aria-hidden="true" />
          {t("accounting.share.wizard.sim.submit")}
        </Button>
      </div>
    </div>
  );
}

// ---- 3. Persetujuan -------------------------------------------------------

function ApprovalStep({
  run,
  onNewRun,
}: {
  run: DistributionRun;
  onNewRun: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const decide = useDecideDistributionRun(run.profitEntityId);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const approve = () => {
    setError(null);
    decide
      .mutateAsync({
        distributionRunId: run.id,
        decision: "approve",
        note: null,
      })
      .then(() =>
        toast({ title: t("accounting.share.wizard.approval.approvedToast") }),
      )
      .catch((caught) => setError(errorMessage(caught)));
  };

  if (run.status === "cancelled")
    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm text-foreground">
          <XCircle className="size-4" aria-hidden="true" />
          <p>{t("accounting.share.wizard.approval.cancelledNote")}</p>
        </div>
        {error && <InlineError message={error} />}
        <div className="flex justify-end">
          <Button type="button" onClick={onNewRun}>
            <PlusCircle aria-hidden="true" />
            {t("accounting.share.runs.new")}
          </Button>
        </div>
      </div>
    );

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("accounting.share.wizard.approval.title")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.share.wizard.approval.pendingNote")}
        </p>
      </div>
      {run.approvedAt && run.approvedBy && (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CircleCheck className="size-4" aria-hidden="true" />
          {t("accounting.share.wizard.approval.approvedInfo", {
            ref: shortActorRef(run.approvedBy),
            date: formatShareDateTime(run.approvedAt),
          })}
        </p>
      )}
      {error && <InlineError message={error} />}
      {run.status === "pending_approval" && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setRejectOpen(true)}
            disabled={decide.isPending}
          >
            <XCircle aria-hidden="true" />
            {t("accounting.share.wizard.approval.reject")}
          </Button>
          <Button
            type="button"
            loading={decide.isPending}
            onClick={approve}
            disabled={decide.isPending}
          >
            <ShieldCheck aria-hidden="true" />
            {t("accounting.share.wizard.approval.approve")}
          </Button>
        </div>
      )}
      <ReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={t("accounting.share.wizard.approval.rejectTitle")}
        label={t("accounting.share.wizard.approval.rejectLabel")}
        hint={t("accounting.share.wizard.approval.rejectHint")}
        submitLabel={t("accounting.share.wizard.approval.reject")}
        pending={decide.isPending}
        onSubmit={(note) => {
          setRejectOpen(false);
          setError(null);
          decide
            .mutateAsync({
              distributionRunId: run.id,
              decision: "reject",
              note,
            })
            .then(() =>
              toast({
                title: t("accounting.share.wizard.approval.rejectedToast"),
              }),
            )
            .catch((caught) => setError(errorMessage(caught)));
        }}
      />
    </div>
  );
}

function LockBanner({
  run,
  onAdjust,
  onCancelApproved,
}: {
  run: DistributionRun;
  onAdjust?: () => void;
  /** Only for visitors who may approve, on a run with no money out. */
  onCancelApproved?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border-(length:--border-w) border-warning bg-warning-subtle p-3">
      <div className="flex min-w-0 items-start gap-2">
        <Lock
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="grid gap-0.5">
          <p className="text-sm font-semibold text-foreground">
            {t("accounting.share.wizard.lock.title")}
          </p>
          <p className="text-sm leading-5 text-foreground">
            {t("accounting.share.wizard.lock.description")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {onCancelApproved && canCancelApprovedRun(run) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onCancelApproved}
          >
            <XCircle aria-hidden="true" />
            {t("accounting.share.wizard.cancelApproved.action")}
          </Button>
        )}
        {onAdjust && isDistributionLocked(run.status) && (
          <Button type="button" size="sm" variant="outline" onClick={onAdjust}>
            <ReceiptText aria-hidden="true" />
            {t("accounting.share.wizard.adjust")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- 4. Pembayaran --------------------------------------------------------

/** API refusals of a withdrawal, in catalog words. */
function cancelApprovedError(error: unknown, t: ReturnType<typeof useT>) {
  if (error instanceof ApiError) {
    if (error.code === "DISTRIBUTION_HAS_ADJUSTMENT")
      return t("accounting.share.wizard.cancelApproved.hasAdjustment");
    if (error.code === "DISTRIBUTION_PARTIALLY_PAID")
      return t("accounting.share.wizard.cancelApproved.partiallyPaid");
  }
  return t("accounting.share.wizard.cancelApproved.failed");
}

function PaymentStep({
  run,
  shareholders,
  onAdjust,
  startCancel,
}: {
  run: DistributionRun;
  shareholders: readonly Shareholder[];
  onAdjust: () => void;
  startCancel: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const record = useRecordDistributionPayment(run.profitEntityId);
  const cancelApproved = useCancelApprovedDistributionRun(run.profitEntityId);
  const canCancel = useCanApproveShareAllocation();
  const [cancelOpen, setCancelOpen] = React.useState(
    startCancel && canCancel && canCancelApprovedRun(run),
  );
  const [cancelError, setCancelError] = React.useState<string | undefined>();
  const [lineId, setLineId] = React.useState<string | null>(null);
  const [paymentRef, setPaymentRef] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const byId = React.useMemo(
    () => new Map(shareholders.map((row) => [row.id, row])),
    [shareholders],
  );
  const progress = distributionProgress(run);
  const selectedLine = run.lines.find((line) => line.id === lineId) ?? null;
  const nameOf = (shareholderId: Shareholder["id"]) =>
    byId.get(shareholderId)?.name ?? t("accounting.share.allocations.unknown");

  const save = async () => {
    if (!selectedLine) return;
    setError(null);
    try {
      await record.mutateAsync({
        distributionRunId: run.id,
        distributionLineId: selectedLine.id,
        body: {
          paymentRef: paymentRef.trim(),
          paidAt: new Date().toISOString(),
        },
      });
      toast({ title: t("accounting.share.wizard.payment.saved") });
      setLineId(null);
      setPaymentRef("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <div className="grid gap-4">
      <LockBanner
        run={run}
        onAdjust={onAdjust}
        onCancelApproved={
          canCancel
            ? () => {
                setCancelError(undefined);
                setCancelOpen(true);
              }
            : undefined
        }
      />
      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t("accounting.share.wizard.cancelApproved.title", {
          period: formatSharePeriod(run.period),
        })}
        label={t("accounting.share.wizard.cancelApproved.label")}
        hint={t("accounting.share.wizard.cancelApproved.hint", {
          amount: formatRupiah(run.distributableIdr),
          min: CANCEL_APPROVED_REASON_MIN,
        })}
        submitLabel={t("accounting.share.wizard.cancelApproved.action")}
        cancelLabel={t("accounting.share.wizard.cancelApproved.back")}
        minLength={CANCEL_APPROVED_REASON_MIN}
        minLengthError={t(
          "accounting.share.wizard.cancelApproved.reasonTooShort",
          { min: CANCEL_APPROVED_REASON_MIN },
        )}
        pending={cancelApproved.isPending}
        formError={cancelError}
        onSubmit={(reason) => {
          setCancelError(undefined);
          cancelApproved
            .mutateAsync({ distributionRunId: run.id, reason })
            .then(() => {
              setCancelOpen(false);
              toast({
                title: t("accounting.share.wizard.cancelApproved.done"),
              });
            })
            .catch((caught) => setCancelError(cancelApprovedError(caught, t)));
        }}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="type-heading">
            {t("accounting.share.wizard.payment.title")}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("accounting.share.wizard.payment.description")}
          </p>
        </div>
        <div className="grid gap-0.5 text-right">
          <p className="type-eyebrow text-muted-foreground">
            {t("accounting.share.wizard.payment.netPaid")}
          </p>
          <p className="font-semibold">
            <Money amount={progress.netPaidIdr} />
          </p>
          <p className="text-sm text-muted-foreground tabular">
            {t("accounting.share.wizard.payment.paidTotal", {
              paid: progress.paidLines,
              total: progress.totalLines,
            })}
          </p>
        </div>
      </div>
      <Table className="min-w-[38rem]">
        <TableHeader>
          <TableRow>
            <TableHead>
              {t("accounting.share.wizard.payment.columns.shareholder")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.share.wizard.payment.columns.net")}
            </TableHead>
            <TableHead>
              {t("accounting.share.wizard.payment.columns.status")}
            </TableHead>
            <TableHead>
              {t("accounting.share.wizard.payment.columns.ref")}
            </TableHead>
            <TableHead className="text-right">
              <span className="sr-only">
                {t("accounting.share.wizard.payment.record")}
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {run.lines.map((line) => (
            <TableRow key={line.id}>
              <TableCell className="font-medium">
                {nameOf(line.shareholderId)}
                {isCarryAbsorbedLine(line) && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t("accounting.share.wizard.payment.zeroLine")}
                  </span>
                )}
              </TableCell>
              <TableCell numeric>
                <Money amount={line.netIdr} />
              </TableCell>
              <TableCell>
                <PaymentStatusBadge
                  status={line.paymentStatus}
                  autoSettled={isCarryAbsorbedLine(line)}
                />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {line.paymentRef ?? t("accounting.share.emptyValue")}
                {line.paidAt && (
                  <>
                    <br />
                    <span className="tabular">
                      {formatShareDateTime(line.paidAt)}
                    </span>
                  </>
                )}
              </TableCell>
              <TableCell className="text-right">
                {line.paymentStatus === "pending" &&
                  !isCarryAbsorbedLine(line) &&
                  canRecordPayments(run.status) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t(
                        "accounting.share.wizard.payment.recordAria",
                        { name: nameOf(line.shareholderId) },
                      )}
                      onClick={() => {
                        setLineId(line.id);
                        setPaymentRef("");
                        setError(null);
                      }}
                    >
                      <Wallet aria-hidden="true" />
                      {t("accounting.share.wizard.payment.record")}
                    </Button>
                  )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {selectedLine && (
        <div className="grid gap-3 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <FormField
            label={t("accounting.share.wizard.payment.ref")}
            hint={t("accounting.share.wizard.payment.refHint")}
            required
          >
            <Input
              value={paymentRef}
              onChange={(event) => setPaymentRef(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </FormField>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLineId(null);
                setPaymentRef("");
              }}
              disabled={record.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={record.isPending}
              disabled={paymentRef.trim() === "" || record.isPending}
              onClick={() => void save()}
            >
              {t("accounting.share.wizard.payment.save")}
            </Button>
          </div>
        </div>
      )}
      {progress.paidLines === progress.totalLines && (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CircleCheck className="size-4" aria-hidden="true" />
          {t("accounting.share.wizard.payment.allPaid")}
        </p>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}

// ---- 5. Pernyataan --------------------------------------------------------

function StatementStep({
  run,
  shareholders,
  onAdjust,
}: {
  run: DistributionRun;
  shareholders: readonly Shareholder[];
  onAdjust: () => void;
}) {
  const t = useT();
  // A zero line was settled by carry: no payment, so no statement.
  const paidLines = run.lines.filter(
    (line) => line.paymentStatus === "paid" && !isCarryAbsorbedLine(line),
  );
  const [lineId, setLineId] = React.useState<string>("");
  const lineFieldId = React.useId();
  const selected =
    paidLines.find((line) => line.id === lineId) ?? paidLines[0] ?? null;
  const statementQuery = useDistributionStatement(
    run.id,
    selected?.id ?? undefined,
  );
  const byId = React.useMemo(
    () => new Map(shareholders.map((row) => [row.id, row])),
    [shareholders],
  );
  const statement = statementQuery.data;

  return (
    <div className="grid gap-4">
      <LockBanner run={run} onAdjust={onAdjust} />
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("accounting.share.wizard.statement.title")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.share.wizard.statement.description")}
        </p>
      </div>
      {paidLines.length === 0 ? (
        <p className="rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm text-muted-foreground">
          {t("accounting.share.wizard.statement.empty")}
        </p>
      ) : (
        <>
          <FormField
            id={lineFieldId}
            label={t("accounting.share.wizard.statement.pick")}
            required
          >
            <Select
              value={selected?.id ?? ""}
              onValueChange={(value) => setLineId(value)}
            >
              <SelectTrigger id={lineFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paidLines.map((line) => (
                  <SelectItem key={line.id} value={line.id}>
                    {byId.get(line.shareholderId)?.name ??
                      t("accounting.share.allocations.unknown")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {statementQuery.isPending ? (
            <div className="grid gap-2" aria-busy="true">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-24 w-full" />
            </div>
          ) : statementQuery.isError ? (
            <ErrorState
              onRetry={() => {
                void statementQuery.refetch();
              }}
            />
          ) : statement ? (
            <dl className="grid gap-2 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm sm:grid-cols-2">
              <Fact
                label={t("accounting.share.wizard.statement.shareholder")}
                value={statement.shareholderName}
              />
              <Fact
                label={t("accounting.share.wizard.statement.entity")}
                value={statement.profitEntityName}
              />
              <Fact
                label={t("accounting.share.wizard.statement.period")}
                value={formatSharePeriod(statement.period)}
              />
              <Fact
                label={t("accounting.share.wizard.statement.basis")}
                value={t("accounting.share.wizard.statement.basisValue")}
              />
              <Fact
                label={t("accounting.share.wizard.statement.runType")}
                value={t(
                  statement.runType === "adjustment"
                    ? "accounting.share.runType.adjustment"
                    : "accounting.share.runType.regular",
                )}
              />
              {statement.adjustsRunId && (
                <Fact
                  label={t("accounting.share.wizard.statement.adjustsRun")}
                  value={shortActorRef(statement.adjustsRunId)}
                />
              )}
              <Fact
                label={t("accounting.share.wizard.statement.share")}
                value={`${formatShareBp(statement.shareBp)} (${formatShareBpInteger(statement.shareBp)} bp)`}
              />
              {selected && selected.carryDeductedIdr > 0 && (
                <Fact
                  label={t("accounting.share.wizard.statement.carryDeducted")}
                  value={<Money amount={selected.carryDeductedIdr} />}
                />
              )}
              <Fact
                label={t("accounting.share.wizard.statement.gross")}
                value={<Money amount={statement.grossIdr} />}
              />
              <Fact
                label={t("accounting.share.wizard.statement.tax")}
                value={<Money amount={statement.taxWithheldIdr} />}
              />
              <Fact
                label={t("accounting.share.wizard.statement.net")}
                value={<Money amount={statement.netIdr} />}
              />
              <Fact
                label={t("accounting.share.wizard.statement.status")}
                value={<PaymentStatusBadge status={statement.paymentStatus} />}
              />
              <Fact
                label={t("accounting.share.wizard.statement.ref")}
                value={statement.paymentRef ?? t("accounting.share.emptyValue")}
              />
              <Fact
                label={t("accounting.share.wizard.statement.paidAt")}
                value={
                  statement.paidAt
                    ? formatShareDateTime(statement.paidAt)
                    : t("accounting.share.emptyValue")
                }
              />
              <Fact
                label={t("accounting.share.wizard.statement.file")}
                value={
                  <span className="break-all tabular">
                    {statement.statementFileKey ??
                      t("accounting.share.emptyValue")}
                  </span>
                }
              />
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("accounting.share.wizard.statement.unpaid")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-border/60 pb-1.5 last:border-0 sm:border-0 sm:pb-0">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
