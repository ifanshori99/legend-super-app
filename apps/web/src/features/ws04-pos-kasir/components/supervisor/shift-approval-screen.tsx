import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import {
  CircleAlert,
  CircleCheck,
  EyeOff,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { fieldClass, Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/errors";
import { isContractPending } from "../../hooks";
import {
  useApproveShiftClose,
  useRequestOverride,
  useShiftPrintLoader,
  useShiftReview,
  useSupervisorOptions,
} from "../../shift-hooks";
import { CloudPrintButton } from "../../print/cloud-print-button";
import { offersForceClose } from "../../shift-extra-logic";
import type { ShiftReview } from "../../types";
import { HeldCashOutGate } from "./held-cash-out-gate";
import { ShiftForceClose } from "./shift-force-close";
import {
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
} from "../shared";

const MINUS = "−";
const PIN_LENGTH = 6;
const NOTE_MIN_LENGTH = 4;

/** "2026-11-08" as "8 November 2026"; the raw value when it does not parse. */
function formatBusinessDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The cashier's count against the system figure. Variance is counted - expected:
// negative is short. Tone, icon and text all say which way it went.
const VARIANCE_TONES = {
  short: {
    box: "border-danger bg-danger-subtle",
    text: "text-danger",
    icon: CircleAlert,
  },
  over: {
    box: "border-warning bg-warning-subtle",
    text: "text-warning",
    icon: TriangleAlert,
  },
  even: {
    box: "border-success bg-success-subtle",
    text: "text-success",
    icon: CircleCheck,
  },
  // Blind view (legend-4wrfd): the variance is hidden, so it is neither short,
  // over nor even. A neutral box, never the green "sesuai".
  hidden: {
    box: "border-border bg-muted",
    text: "text-muted-foreground",
    icon: EyeOff,
  },
} as const;

/** A figure hidden from the caller: a dash, announced as "hidden" to screen readers. */
function HiddenFigure() {
  const t = useT();
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">
        {t("posKasirSupervisor.result.figureHidden")}
      </span>
    </>
  );
}

function VarianceBlock({ review }: { review: ShiftReview }) {
  const t = useT();
  const { varianceIdr } = review;
  const kind =
    varianceIdr === null
      ? "hidden"
      : varianceIdr < 0
        ? "short"
        : varianceIdr > 0
          ? "over"
          : "even";
  const tone = VARIANCE_TONES[kind];
  const Icon = tone.icon;
  return (
    <div
      className={cn(
        "rounded-control border-(length:--border-w) px-4 py-3",
        tone.box,
      )}
      data-variance={kind}
    >
      <p
        className={cn(
          "flex items-center gap-2 text-sm font-semibold tracking-wide uppercase",
          tone.text,
        )}
      >
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        {t(`posKasirSupervisor.result.${kind}`)}
      </p>
      {varianceIdr === null ? (
        <p className="tabular text-2xl font-bold">
          <HiddenFigure />
        </p>
      ) : (
        <Money amount={Math.abs(varianceIdr)} size="stat" />
      )}
      <p className="tabular text-base text-foreground">
        {t("posKasirSupervisor.result.countedLine", {
          amount: formatRupiah(review.countedIdr),
        })}
      </p>
      {varianceIdr === null && (
        <p className="mt-2 text-base leading-6 text-muted-foreground">
          {t("posKasirSupervisor.result.hiddenHint")}
        </p>
      )}
    </div>
  );
}

function BreakdownRow({
  label,
  amountIdr,
  sign,
}: {
  label: string;
  /** null: hidden from the caller (blind view), shown as a dash. */
  amountIdr: number | null;
  sign?: "+" | typeof MINUS;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
      <dt>{label}</dt>
      <dd className="font-semibold">
        {amountIdr === null ? (
          <HiddenFigure />
        ) : (
          <>
            {sign && amountIdr > 0 && <span className="tabular">{sign} </span>}
            <Money amount={amountIdr} className="font-semibold" />
          </>
        )}
      </dd>
    </div>
  );
}

function ResultPanel({ review }: { review: ShiftReview }) {
  const t = useT();
  const { breakdown } = review;
  return (
    <PosPanel
      title={t("posKasirSupervisor.result.title")}
      aside={
        <StatusPill tone="neutral">
          {t("posKasirSupervisor.result.locked")}
        </StatusPill>
      }
    >
      <div className="grid gap-5">
        <VarianceBlock review={review} />
        <dl className="grid gap-2.5">
          <BreakdownRow
            label={t("posKasirSupervisor.breakdown.openingFloat")}
            amountIdr={breakdown.openingFloatIdr}
          />
          <BreakdownRow
            label={t("posKasirSupervisor.breakdown.cashSales")}
            amountIdr={breakdown.cashSalesIdr}
            sign="+"
          />
          <BreakdownRow
            label={t("posKasirSupervisor.breakdown.cashRefunds")}
            amountIdr={breakdown.cashRefundsIdr}
            sign={MINUS}
          />
          <BreakdownRow
            label={t("posKasirSupervisor.breakdown.cashIn")}
            amountIdr={breakdown.cashInIdr}
            sign="+"
          />
          <BreakdownRow
            label={t("posKasirSupervisor.breakdown.cashOutCounted")}
            amountIdr={breakdown.cashOutIdr}
            sign={MINUS}
          />
          <BreakdownRow
            label={t("posKasirSupervisor.breakdown.cashDrop")}
            amountIdr={breakdown.cashDropIdr}
            sign={MINUS}
          />
        </dl>
        <dl className="border-t-(length:--border-w) border-border pt-3">
          <div className="flex items-baseline justify-between gap-3 text-(length:--density-text) font-bold">
            <dt>{t("posKasirSupervisor.breakdown.expected")}</dt>
            <dd>
              {review.expectedIdr === null ? (
                <HiddenFigure />
              ) : (
                <Money amount={review.expectedIdr} className="font-bold" />
              )}
            </dd>
          </div>
        </dl>
        {review.varianceIdr !== null && (
          <p className="border-t-(length:--border-w) border-border pt-4 text-base leading-6 text-muted-foreground">
            {t("posKasirSupervisor.result.systemOnlyHint")}
          </p>
        )}
      </div>
    </PosPanel>
  );
}

/** Where a failed approval shows: on the PIN field, or as a notice for the rest. */
type SubmitProblem = { field: "pin" | "form"; message: string };

// Only the PIN step can blame the PIN. A FORBIDDEN from the approve step means
// the approver may not close this shift, which the PIN field cannot fix.
function toProblem(
  error: unknown,
  stage: "override" | "approve",
): SubmitProblem {
  if (error instanceof ApiError) {
    const onPin =
      stage === "override" &&
      (error.code === "PIN_INVALID" ||
        error.code === "PIN_LOCKED" ||
        error.code === "FORBIDDEN");
    return { field: onPin ? "pin" : "form", message: error.message };
  }
  return { field: "form", message: "" };
}

// An approval already granted for this approver and reason. Kept so a retried
// approve does not ask the supervisor for the PIN again.
type GrantedOverride = {
  overrideId: string;
  approverUserId: string;
  reason: string;
};

function ReviewForm({
  review,
  onBack,
}: {
  review: ShiftReview;
  onBack: () => void;
}) {
  const t = useT();
  const noteId = useId();
  const pinId = useId();
  const supervisorId = useId();
  const supervisors = useSupervisorOptions();
  const requestOverride = useRequestOverride();
  const approve = useApproveShiftClose();
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [chosen, setChosen] = useState("");
  const [noteError, setNoteError] = useState<string>();
  const [pinError, setPinError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const granted = useRef<GrantedOverride | null>(null);

  // A hidden (null) variance is unknown: do not claim one, and send 0 as the
  // override value. The note stays required either way.
  const hasVariance = review.varianceIdr !== null && review.varianceIdr !== 0;
  const options = supervisors.data ?? [];
  const approverUserId = chosen || options[0]?.userId || "";
  const pending = requestOverride.isPending || approve.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = note.trim();
    const noteProblem =
      trimmed.length < NOTE_MIN_LENGTH
        ? t("posKasirSupervisor.review.reasonRequired")
        : undefined;
    const pinProblem = new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)
      ? undefined
      : t("posKasirSupervisor.review.pinInvalid");
    setNoteError(noteProblem);
    setPinError(pinProblem);
    setFormError(undefined);
    if (noteProblem || pinProblem || approverUserId === "") return;
    let stage: "override" | "approve" = "override";
    try {
      // Supervisor PIN in, `overrideId` out; the close consumes that id.
      const reusable =
        granted.current?.approverUserId === approverUserId &&
        granted.current.reason === trimmed
          ? granted.current
          : null;
      let overrideId = reusable?.overrideId;
      if (overrideId === undefined) {
        const override = await requestOverride.mutateAsync({
          action: "cash_shift_close",
          valueIdr: Math.abs(review.varianceIdr ?? 0),
          reason: trimmed,
          objectType: "cash_shift",
          objectId: review.shiftId,
          approverUserId,
          pin,
        });
        overrideId = override.overrideId;
        granted.current = {
          overrideId,
          approverUserId,
          reason: trimmed,
        };
      }
      stage = "approve";
      await approve.mutateAsync({
        shiftId: review.shiftId,
        overrideId,
        reason: trimmed,
      });
    } catch (error) {
      // A spent or rejected override cannot be reused: ask for the PIN again.
      if (
        error instanceof ApiError &&
        (error.code === "OVERRIDE_INVALID" || error.code === "OVERRIDE_USED")
      ) {
        granted.current = null;
      }
      const problem = toProblem(error, stage);
      if (problem.field === "pin") {
        setPin("");
        setPinError(problem.message);
      } else {
        setFormError(problem.message);
      }
    }
  }

  const required = (text: string): ReactNode => (
    <>
      {text}{" "}
      <span className="font-normal text-muted-foreground">
        · {t("posKasirSupervisor.review.required")}
      </span>
    </>
  );

  if (supervisors.isError) {
    return (
      <PosPanel title={t("posKasirSupervisor.review.title")}>
        <ErrorState
          error={supervisors.error}
          title={t("posKasirSupervisor.state.supervisorsErrorTitle")}
          description={t("posKasirSupervisor.state.supervisorsErrorHint")}
          onRetry={() => void supervisors.refetch()}
        />
      </PosPanel>
    );
  }

  if (supervisors.isSuccess && options.length === 0) {
    return (
      <PosPanel title={t("posKasirSupervisor.review.title")}>
        <EmptyState
          icon={ShieldCheck}
          title={t("posKasirSupervisor.state.noSupervisorTitle")}
          description={t("posKasirSupervisor.state.noSupervisorHint")}
        />
      </PosPanel>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="h-full">
      <PosPanel
        title={t("posKasirSupervisor.review.title")}
        footer={
          <>
            <Button type="button" variant="outline" onClick={onBack}>
              {t("posKasirSupervisor.back")}
            </Button>
            <Button
              type="submit"
              disabled={pending || supervisors.isPending}
              aria-busy={pending || undefined}
            >
              {pending
                ? t("posKasirSupervisor.review.submitting")
                : t("posKasirSupervisor.review.submit")}
            </Button>
          </>
        }
      >
        <div className="grid content-start gap-5">
          {formError !== undefined && (
            <Notice
              tone="danger"
              title={t("posKasirSupervisor.review.failedTitle")}
            >
              {formError === ""
                ? t("posKasirSupervisor.review.failedHint")
                : formError}
            </Notice>
          )}
          <FormField
            label={required(
              hasVariance
                ? t("posKasirSupervisor.review.varianceLabel")
                : t("posKasirSupervisor.review.noteLabel"),
            )}
            id={noteId}
            required
            error={noteError}
          >
            <Textarea
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                if (noteError) setNoteError(undefined);
              }}
              rows={3}
            />
          </FormField>
          {options.length > 1 && (
            <FormField
              label={t("posKasirSupervisor.review.supervisorLabel")}
              id={supervisorId}
              required
            >
              <select
                className={cn(fieldClass, "h-control px-3")}
                value={approverUserId}
                onChange={(event) => setChosen(event.target.value)}
              >
                {options.map((option) => (
                  <option key={option.userId} value={option.userId}>
                    {option.name}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          <FormField
            label={t("posKasirSupervisor.review.pinLabel")}
            id={pinId}
            required
            error={pinError}
          >
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={PIN_LENGTH}
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, ""));
                if (pinError) setPinError(undefined);
              }}
              className="tabular text-2xl tracking-[0.5em]"
            />
          </FormField>
          <Notice
            tone="warning"
            title={t("posKasirSupervisor.review.lockTitle")}
          >
            {t("posKasirSupervisor.review.lockBody")}
          </Notice>
          <p className="text-base leading-6 text-muted-foreground">
            {t("posKasirSupervisor.review.afterClose")}
          </p>
        </div>
      </PosPanel>
    </form>
  );
}

function ClosedPanel({
  review,
  onBack,
}: {
  review: ShiftReview;
  onBack: () => void;
}) {
  const t = useT();
  const loadPrint = useShiftPrintLoader(review.shiftId);
  return (
    <PosPanel
      title={t("posKasirSupervisor.closed.title")}
      aside={
        <StatusPill tone="success">
          {t("posKasirSupervisor.closed.pill")}
        </StatusPill>
      }
      footer={
        <Button type="button" onClick={onBack}>
          {t("posKasirSupervisor.back")}
        </Button>
      }
    >
      <div className="grid content-start gap-4" aria-live="polite">
        <p className="text-(length:--density-text) leading-6">
          {t("posKasirSupervisor.closed.body", {
            approver: review.approvedByName ?? "",
          })}
        </p>
        {/* Blind view: no note, and never "Tidak ada selisih" for an unknown variance. */}
        {review.varianceIdr !== null && (
          <div className="grid gap-1">
            <p className="text-base font-semibold">
              {t("posKasirSupervisor.closed.noteLabel")}
            </p>
            <p className="text-(length:--density-text) leading-6 text-muted-foreground">
              {review.varianceNote
                ? review.varianceNote
                : t("posKasirSupervisor.closed.noNote")}
            </p>
          </div>
        )}
        {/* The report carries expected cash and variance: only a caller who
          sees live figures (never the shift's own blind cashier) gets it. */}
        {review.expectedIdr !== null && (
          <CloudPrintButton
            kind="shift"
            printKey={`shift-report:${review.shiftId}`}
            load={loadPrint}
          />
        )}
      </div>
    </PosPanel>
  );
}

function LoadingBlock() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("posKasirSupervisor.state.loadingLabel")}
      className="grid gap-4 md:grid-cols-2"
    >
      <div className="grid gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-32 w-full" />
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
      <div className="grid gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

function ReviewProblem({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  if (isContractPending(error)) {
    return (
      <ErrorState
        title={t("posKasirSupervisor.state.pendingTitle")}
        description={t("posKasirSupervisor.state.pendingHint")}
      />
    );
  }
  if (error instanceof ApiError && error.code === "COUNT_NOT_SUBMITTED") {
    return (
      <EmptyState
        title={t("posKasirSupervisor.state.notReadyTitle")}
        description={t("posKasirSupervisor.state.notReadyHint")}
      />
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t("posKasirSupervisor.state.notFoundTitle")}
        description={t("posKasirSupervisor.state.notFoundHint")}
      />
    );
  }
  return (
    <ErrorState
      error={error}
      title={t("posKasirSupervisor.state.errorTitle")}
      description={t("posKasirSupervisor.state.errorHint")}
      onRetry={onRetry}
    />
  );
}

// /pos/supervisor/shift/$shiftId: the supervisor sees the cashier's count next
// to the system figure (the cashier never does, blind count), explains any
// variance and approves with a PIN. The approval closes the shift and locks it.
export function ShiftApprovalScreen({ shiftId }: { shiftId: string }) {
  const t = useT();
  const router = useRouter();
  const query = useShiftReview(shiftId);
  const review = query.data;
  const goBack = () => router.history.back();
  const [forceClosing, setForceClosing] = useState(false);

  if (forceClosing)
    return (
      <ShiftForceClose
        shiftId={shiftId}
        onBack={() => setForceClosing(false)}
      />
    );

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirSupervisor.title")}
        subtitle={
          review
            ? t("posKasirSupervisor.subtitle", {
                shiftNo: review.shiftNo,
                cashier: review.cashierName,
                terminal: review.terminalLabel,
                date: formatBusinessDate(review.businessDate),
              })
            : undefined
        }
        action={
          <StatusPill tone="warning" icon={ShieldCheck}>
            {t("posKasirSupervisor.access")}
          </StatusPill>
        }
      />
      {query.isPending ? (
        <LoadingBlock />
      ) : query.isError || !review ? (
        <div className="grid justify-items-center gap-2">
          <ReviewProblem
            error={query.error}
            onRetry={() => void query.refetch()}
          />
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" onClick={goBack}>
              {t("posKasirSupervisor.back")}
            </Button>
            {/* O4: the review is not on the server yet, the force close is. A
                tablet that is lost or offline never locks the cafe; nor does
                a cashier who never sent a count (review K P3). */}
            {offersForceClose(query.error) && (
              <Button type="button" onClick={() => setForceClosing(true)}>
                {t("posKasirSupervisor.force.closeForce")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <PosTwoPane
          className="md:grid-cols-2"
          side={<ResultPanel review={review} />}
        >
          {review.status === "closed" ? (
            <ClosedPanel review={review} onBack={goBack} />
          ) : (
            <HeldCashOutGate
              shiftId={review.shiftId}
              onBack={goBack}
              onForceClose={() => setForceClosing(true)}
            >
              <ReviewForm review={review} onBack={goBack} />
            </HeldCashOutGate>
          )}
        </PosTwoPane>
      )}
    </div>
  );
}
