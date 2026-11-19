// The two writes of the recon screen: propose a clearance (first person) and
// approve it (second person). The password is asked here and never kept: the
// field is emptied the moment it is sent. MFA or a fresh login is asked
// through the same step-up panel as the other payout actions. The server stays
// the checker (self-approval, changed data, permission); a refusal shows here.
import * as React from "react";
import type { PayoutReconFlagDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isReconConflict } from "../errors";
import { useApproveReconClearance, useProposeReconClearance } from "../hooks";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { ReconCallout } from "./recon-parts";
import { REASON_MAX, reasonProblem, type ReconNotice } from "./recon-model";
import { reviewErrorMessage } from "./status-errors";
import { ApiError } from "@/lib/api/errors";

/** Same handling for both writes: step-up, conflict, or the refusal in words. */
function useWriteFailure(onNotice: (notice: ReconNotice) => void) {
  const t = useT();
  const stepUp = useStepUp({ acceptsPassword: true });
  const [error, setError] = React.useState<string | null>(null);
  const fail = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    if (isReconConflict(failure)) {
      onNotice({
        kind:
          failure instanceof ApiError &&
          failure.code === "PAYOUT_RECON_FLAG_CHANGED"
            ? "changed"
            : "stale",
      });
      return;
    }
    setError(reviewErrorMessage(failure, t));
  };
  return { stepUp, error, setError, fail };
}

export function ReconProposeForm({
  flag,
  onNotice,
}: {
  flag: PayoutReconFlagDto;
  onNotice: (notice: ReconNotice) => void;
}) {
  const t = useT();
  const propose = useProposeReconClearance();
  const { stepUp, error, setError, fail } = useWriteFailure(onNotice);
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  // A field shows its problem once left (blur) or after a send attempt.
  const [touched, setTouched] = React.useState({
    reason: false,
    password: false,
  });
  const [attempted, setAttempted] = React.useState(false);
  const reasonBad = touched.reason && reasonProblem(reason);
  const passwordBad = touched.password && !stepUp.active && password === "";

  const send = (proof?: string) => {
    if (propose.isPending) return;
    setError(null);
    propose.mutate(
      { flagId: flag.id, reason: reason.trim(), password: proof },
      {
        onSuccess: () => {
          stepUp.reset();
          setReason("");
          onNotice({ kind: "sent", flagId: flag.id });
        },
        onError: fail,
      },
    );
  };

  return (
    <div className="grid gap-4">
      <form
        noValidate
        aria-label={t("payrollPayoutReview.recon.propose.title")}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (stepUp.active) return;
          if (reasonProblem(reason) || password === "") {
            setTouched({ reason: true, password: true });
            setAttempted(true);
            // First field with a problem takes focus.
            document
              .getElementById(
                reasonProblem(reason) ? "recon-reason" : "recon-password",
              )
              ?.focus();
            return;
          }
          const proof = password;
          setPassword("");
          setTouched({ reason: false, password: false });
          setAttempted(false);
          send(proof);
        }}
      >
        {attempted && (reasonBad || passwordBad) && (
          <ReconCallout
            tone="danger"
            role="alert"
            title={t("payrollPayoutReview.recon.propose.invalidTitle")}
          >
            {t("payrollPayoutReview.recon.propose.invalidBody")}
          </ReconCallout>
        )}
        <div className="grid gap-1">
          <FormField
            id="recon-reason"
            required
            label={
              <Required>
                {t("payrollPayoutReview.recon.propose.reasonLabel")}
              </Required>
            }
            hint={t("payrollPayoutReview.recon.propose.reasonHint")}
            error={
              reasonBad
                ? t("payrollPayoutReview.recon.propose.reasonError")
                : undefined
            }
          >
            <Textarea
              name="reason"
              value={reason}
              onBlur={() => setTouched((now) => ({ ...now, reason: true }))}
              maxLength={REASON_MAX}
              rows={5}
              placeholder={t(
                "payrollPayoutReview.recon.propose.reasonPlaceholder",
              )}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <p className="text-right text-xs text-muted-foreground tabular">
            {t("payrollPayoutReview.recon.propose.counter", {
              count: reason.length,
            })}
          </p>
        </div>
        {!stepUp.active && (
          <>
            <PasswordField
              value={password}
              onChange={setPassword}
              onBlur={() => setTouched((now) => ({ ...now, password: true }))}
              invalid={passwordBad}
            />
            {error && (
              <ReconCallout
                tone="danger"
                role="alert"
                title={t("payrollPayoutReview.recon.propose.failedTitle")}
              >
                {error}
              </ReconCallout>
            )}
            <Button
              type="submit"
              className="min-h-11 w-full"
              loading={propose.isPending}
            >
              {t("payrollPayoutReview.recon.propose.submit")}
            </Button>
          </>
        )}
      </form>
      {stepUp.active && (
        <VerifyPanel
          key={stepUp.round}
          needs={stepUp.needs}
          busy={propose.isPending}
          error={error}
          onVerified={send}
          onCancel={stepUp.reset}
        />
      )}
      <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
        {t("payrollPayoutReview.recon.propose.note")}
      </p>
    </div>
  );
}

export function ReconApproveForm({
  flag,
  onNotice,
}: {
  flag: PayoutReconFlagDto;
  onNotice: (notice: ReconNotice) => void;
}) {
  const t = useT();
  const approve = useApproveReconClearance();
  const { stepUp, error, setError, fail } = useWriteFailure(onNotice);
  const [password, setPassword] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const clearanceId = flag.clearance?.id;
  const passwordBad = touched && !stepUp.active && password === "";

  const send = (proof?: string) => {
    if (approve.isPending || !clearanceId) return;
    setError(null);
    approve.mutate(
      { clearanceId, password: proof },
      {
        onSuccess: () => {
          stepUp.reset();
          onNotice({ kind: "approved", flagId: flag.id });
        },
        onError: fail,
      },
    );
  };

  return (
    <div className="grid gap-4">
      <form
        noValidate
        aria-label={t("payrollPayoutReview.recon.approve.title")}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (stepUp.active) return;
          if (password === "") {
            setTouched(true);
            document.getElementById("recon-password")?.focus();
            return;
          }
          const proof = password;
          setPassword("");
          setTouched(false);
          send(proof);
        }}
      >
        {!stepUp.active && (
          <>
            <PasswordField
              value={password}
              onChange={setPassword}
              onBlur={() => setTouched(true)}
              invalid={passwordBad}
            />
            {error && (
              <ReconCallout
                tone="danger"
                role="alert"
                title={t("payrollPayoutReview.recon.approve.failedTitle")}
              >
                {error}
              </ReconCallout>
            )}
            <Button
              type="submit"
              className="min-h-11 w-full"
              loading={approve.isPending}
            >
              {t("payrollPayoutReview.recon.approve.submit")}
            </Button>
          </>
        )}
      </form>
      {stepUp.active && (
        <VerifyPanel
          key={stepUp.round}
          needs={stepUp.needs}
          busy={approve.isPending}
          error={error}
          onVerified={send}
          onCancel={stepUp.reset}
        />
      )}
    </div>
  );
}

/** Label text with a visible "*" and a spoken "wajib". */
export function Required({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <>
      {children} <span aria-hidden="true">*</span>
      <span className="sr-only">
        {" "}
        ({t("payrollPayoutReview.recon.required")})
      </span>
    </>
  );
}

export function PasswordField({
  value,
  onChange,
  onBlur,
  invalid,
  id = "recon-password",
  label,
  error,
}: {
  /** Unique per form when several forms share a page. */
  id?: string;
  /** Replaces the default label/problem text, e.g. for the hold forms. */
  label?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  invalid: boolean;
}) {
  const t = useT();
  return (
    <FormField
      id={id}
      required
      label={
        <Required>
          {label ?? t("payrollPayoutReview.recon.propose.passwordLabel")}
        </Required>
      }
      error={
        invalid
          ? (error ?? t("payrollPayoutReview.recon.propose.passwordError"))
          : undefined
      }
    >
      <Input
        type="password"
        name="password"
        autoComplete="current-password"
        onBlur={onBlur}
        maxLength={128}
        className="min-h-11"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}
