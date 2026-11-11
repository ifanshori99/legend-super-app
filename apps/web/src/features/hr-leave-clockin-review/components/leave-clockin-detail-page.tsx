// Detail of one clock-in on an approved leave day (bead legend-3jem1). A page,
// not a modal, so it deep-links and reads on a phone. HR keeps the leave or
// cancels it for this date only; both go through a confirmation dialog, and the
// saved decision replaces the actions on this same page.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleCheck,
  Info,
  Lock,
  PencilLine,
  RotateCcw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { formatBusinessDate } from "@/features/ws10-attendance-qr/format.ts";
import { ATTENDANCE_TIME_ZONE } from "@/features/ws10-attendance-qr/outlet.ts";
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import type { MessageKey } from "@starter/shared/i18n";
import { formatClockMinutes } from "../format.ts";
import {
  leaveClockinErrorKey,
  useDecideLeaveClockin,
  useLeaveClockinCase,
  useLeaveClockinPermissions,
} from "../hooks.ts";
import type { LeaveClockinAction, LeaveClockinCase } from "../types.ts";
import { DecisionDialog } from "./decision-dialog.tsx";
import { DecisionResult } from "./decision-result.tsx";

const CANCEL_REASON_ID = "leave-clockin-cancel-reason";
const KEEP_REASON_ID = "leave-clockin-keep-reason";

/** 409 codes that retrying the same confirmation can never fix. */
const TERMINAL_CODES = new Set([
  "ATTENDANCE_LEAVE_NOT_APPROVED",
  "ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED",
  "ATTENDANCE_LEAVE_STILL_APPROVED",
  "ATTENDANCE_LEAVE_NOT_REACHABLE",
  "ATTENDANCE_LEAVE_DAYS_MISMATCH",
  "ATTENDANCE_LEAVE_DECISION_REQUIRED",
  "ATTENDANCE_CORRECTION_LEAVE_DAY",
]);

/** Terminal: the server refused for good (no right, or the state moved on). */
function isTerminalError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 403 || TERMINAL_CODES.has(error.code))
  );
}

/** The action a saved decision stands for (never "pending"). */
function actionOfDecision(
  decision: LeaveClockinCase["decision"],
): LeaveClockinAction | null {
  if (decision === "kept_leave") return "keep_leave";
  if (decision === "cancelled_leave") return "cancel_leave";
  return null;
}

export function LeaveClockinDetailPage({ logId }: { logId: string }) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const query = useLeaveClockinCase(logId);
  const decide = useDecideLeaveClockin();
  // The decided case and the confirmed action: the queue refetch drops it from
  // the pending list, so the result is kept here (not in the panel, which can
  // unmount mid-save) to keep it on screen.
  const [decided, setDecided] = React.useState<{
    leaveCase: LeaveClockinCase;
    action: LeaveClockinAction;
  } | null>(null);
  const [action, setAction] = React.useState<LeaveClockinAction | null>(null);
  // One key per confirmation session: a retry replays it, a new dialog gets a
  // fresh one. The lock stops a second submit before the first settles.
  const idempotencyKey = React.useRef<string | null>(null);
  const inFlight = React.useRef(false);
  const leaveCase = decided?.leaveCase ?? query.data ?? null;

  const open = (next: LeaveClockinAction) => {
    decide.reset();
    idempotencyKey.current = crypto.randomUUID();
    setAction(next);
  };
  const close = () => {
    idempotencyKey.current = null;
    setAction(null);
  };
  const confirm = async () => {
    if (action === null || leaveCase === null || inFlight.current) return;
    inFlight.current = true;
    const confirmed = action;
    const key = (idempotencyKey.current ??= crypto.randomUUID());
    try {
      const saved = await decide.mutateAsync({
        case: leaveCase,
        action: confirmed,
        idempotencyKey: key,
      });
      idempotencyKey.current = null;
      setDecided({ leaveCase: saved, action: confirmed });
      setAction(null);
      toast({
        title:
          confirmed === "keep_leave"
            ? t("leaveClockinReview.toast.kept")
            : t("leaveClockinReview.toast.cancelled"),
        tone: "success",
      });
    } catch {
      // Shown in the dialog through `decide.error`; the key stays for a retry.
    } finally {
      inFlight.current = false;
    }
  };
  const errorMessage = decide.error
    ? t(leaveClockinErrorKey(decide.error) as MessageKey)
    : null;
  const savedAction =
    leaveCase === null ? null : actionOfDecision(leaveCase.decision);

  const back = (
    <Button asChild variant="ghost" className="-ml-2 w-fit">
      <Link to="/kelola/absensi/tinjauan-cuti">
        <ArrowLeft aria-hidden="true" />
        {t("leaveClockinReview.detail.back")}
      </Link>
    </Button>
  );

  let body: React.ReactNode;
  if (decided === null && query.isPending) {
    body = <DetailSkeleton label={t("leaveClockinReview.loading.label")} />;
  } else if (decided === null && query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title={t("leaveClockinReview.error.detailTitle")}
        description={t("leaveClockinReview.error.detailDescription")}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (leaveCase === null) {
    body = (
      <EmptyState
        title={t("leaveClockinReview.notFound.title")}
        description={t("leaveClockinReview.notFound.description")}
        action={
          <Button asChild variant="outline">
            <Link to="/kelola/absensi/tinjauan-cuti">
              {t("leaveClockinReview.detail.back")}
            </Link>
          </Button>
        }
      />
    );
  } else if (decided !== null) {
    body = (
      <DecisionResult leaveCase={decided.leaveCase} action={decided.action} />
    );
  } else if (savedAction !== null) {
    // Decided elsewhere (another tab, a refetch): no live buttons.
    body = <DecisionResult leaveCase={leaveCase} action={savedAction} />;
  } else {
    body = <DecisionPanel leaveCase={leaveCase} onChoose={open} />;
  }

  return (
    <div className="grid min-w-0 gap-4">
      {back}
      <h2 className="type-title">{t("leaveClockinReview.detail.title")}</h2>
      {!online && (
        <div
          role="status"
          className="flex flex-col items-start gap-1.5 rounded-container border-(length:--border-w) bg-warning-subtle p-card"
        >
          <StatusPill status="warning" icon={WifiOff}>
            {t("leaveClockinReview.offline.title")}
          </StatusPill>
          <p className="text-sm leading-5 text-warning">
            {t("leaveClockinReview.offline.description")}
          </p>
        </div>
      )}
      {body}
      {leaveCase !== null && (
        <DecisionDialog
          action={action}
          businessDate={leaveCase.businessDate}
          pending={decide.isPending}
          offline={!online}
          blocked={isTerminalError(decide.error)}
          errorMessage={errorMessage}
          onConfirm={() => void confirm()}
          onOpenChange={(next) => {
            if (!next) close();
          }}
        />
      )}
    </div>
  );
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="grid gap-4"
    >
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <Skeleton className="h-6 w-40" />
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[8rem_1fr] gap-3 sm:grid-cols-[12rem_1fr]"
          >
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-32 max-w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-5 w-64 max-w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}

function kindStatus(kind: LeaveClockinCase["kind"]) {
  switch (kind) {
    case "manual_correction":
      return {
        status: "info",
        icon: PencilLine,
        label: "leaveClockinReview.status.manualCorrection",
      } as const;
    case "re_review":
      return {
        status: "warning",
        icon: RotateCcw,
        label: "leaveClockinReview.status.reReview",
      } as const;
    default:
      return {
        status: "warning",
        icon: TriangleAlert,
        label: "leaveClockinReview.status.leaveClockIn",
      } as const;
  }
}

function DecisionPanel({
  leaveCase,
  onChoose,
}: {
  leaveCase: LeaveClockinCase;
  onChoose: (action: LeaveClockinAction) => void;
}) {
  const t = useT();
  const permissions = useLeaveClockinPermissions();

  const date = formatBusinessDate(leaveCase.businessDate);
  const kind = kindStatus(leaveCase.kind);
  const unknown = t("leaveClockinReview.detail.unknownValue");
  const leave = leaveCase.leave;
  const canCancel = permissions.canCancelLeave;
  const canKeep = permissions.canKeepLeave;

  const facts: { label: string; value: React.ReactNode }[] = [
    {
      label: t("leaveClockinReview.detail.employee"),
      value:
        leaveCase.employeeName ??
        t("leaveClockinReview.detail.unknownEmployee"),
    },
    ...(leaveCase.kind === "manual_correction"
      ? [
          {
            label: t("leaveClockinReview.detail.caseKind"),
            value: t("leaveClockinReview.kind.manualCorrection"),
          },
        ]
      : []),
    {
      label: t("leaveClockinReview.detail.leaveType"),
      value: leave?.typeName ?? unknown,
    },
    {
      label: t("leaveClockinReview.detail.leavePeriod"),
      value: leave ? (
        <span className="tabular">
          {leave.startDate === leave.endDate
            ? formatBusinessDate(leave.startDate)
            : t("leaveClockinReview.detail.leavePeriodRange", {
                start: formatBusinessDate(leave.startDate),
                end: formatBusinessDate(leave.endDate),
              })}
        </span>
      ) : (
        unknown
      ),
    },
    {
      label: t("leaveClockinReview.detail.attendanceDate"),
      value: <span className="tabular">{date}</span>,
    },
    {
      label: t("leaveClockinReview.detail.clockIn"),
      value: (
        <span className="tabular">
          {formatClockMinutes(leaveCase.clockInAt, ATTENDANCE_TIME_ZONE)}
        </span>
      ),
    },
    {
      label: t("leaveClockinReview.detail.clockOut"),
      value:
        leaveCase.clockOutAt === null ? (
          t("leaveClockinReview.detail.clockOutMissing")
        ) : (
          <span className="tabular">
            {formatClockMinutes(leaveCase.clockOutAt, ATTENDANCE_TIME_ZONE)}
          </span>
        ),
    },
  ];

  return (
    <div className="grid gap-4">
      <section
        aria-labelledby="leave-clockin-summary"
        className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 id="leave-clockin-summary" className="type-heading">
            {t("leaveClockinReview.detail.summaryTitle")}
          </h3>
          <StatusPill status={kind.status} icon={kind.icon}>
            {t(kind.label)}
          </StatusPill>
        </div>
        {leaveCase.kind === "re_review" && (
          <p className="text-sm leading-5 font-medium text-warning">
            {t("leaveClockinReview.reReview.note")}
          </p>
        )}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[12rem_1fr]">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="grid grid-cols-[8rem_1fr] gap-3 sm:contents"
            >
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 font-semibold break-words">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="flex items-start gap-2 rounded-container bg-info-subtle p-3 text-sm leading-5 text-info">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("leaveClockinReview.detail.pending")}
        </p>
      </section>

      <section
        aria-labelledby="leave-clockin-decision"
        className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
      >
        <div className="grid gap-1">
          <h3 id="leave-clockin-decision" className="type-heading">
            {t("leaveClockinReview.decision.title")}
          </h3>
          <p className="text-sm leading-5">
            {t("leaveClockinReview.decision.prompt", { date })}
          </p>
        </div>

        <div className="grid items-start gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Button
              className="min-h-11 w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-disabled={canKeep ? undefined : "true"}
              aria-describedby={canKeep ? undefined : KEEP_REASON_ID}
              onClick={() => {
                // aria-disabled keeps the button focusable for the reason.
                if (canKeep) onChoose("keep_leave");
              }}
            >
              <CircleCheck aria-hidden="true" />
              {t("leaveClockinReview.decision.keepLeave")}
            </Button>
            {!canKeep && (
              <p
                id={KEEP_REASON_ID}
                className="flex items-start gap-1.5 text-sm leading-5 text-muted-foreground"
              >
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {t("leaveClockinReview.decision.noKeepRight")}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Button
              variant="outline"
              className="min-h-11 w-full whitespace-normal aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-disabled={canCancel ? undefined : "true"}
              aria-describedby={canCancel ? undefined : CANCEL_REASON_ID}
              onClick={() => {
                if (canCancel) onChoose("cancel_leave");
              }}
            >
              {t("leaveClockinReview.decision.cancelLeave")}
            </Button>
            {!canCancel && (
              <p
                id={CANCEL_REASON_ID}
                className="flex items-start gap-1.5 text-sm leading-5 text-muted-foreground"
              >
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {t("leaveClockinReview.decision.noCancelRight")}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-1.5 rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground">
          <p>{t("leaveClockinReview.decision.impact")}</p>
          {(leave?.multiDay ?? false) && (
            <p className="font-medium text-foreground">
              {t("leaveClockinReview.decision.multiDayNote")}
            </p>
          )}
          {leaveCase.kind === "manual_correction" && (
            <p>{t("leaveClockinReview.decision.manualCorrectionNote")}</p>
          )}
          <p>{t("leaveClockinReview.decision.payrollNote")}</p>
        </div>
      </section>
    </div>
  );
}
