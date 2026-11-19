// The two writes of the hold section: propose releasing a hold (first person)
// and approve it (second person). The password is asked here and never kept:
// the field is emptied the moment it is sent. MFA or a fresh login goes through
// the same step-up panel as the other payout actions. The server stays the
// checker (self-approval, evidence, a flag that took over); a refusal shows
// here and the slip stays held.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/errors";
import type { PayoutReconHoldDto } from "@starter/shared/types";
import { isHoldConflict } from "../errors";
import {
  useApproveReconHoldRelease,
  useProposeReconHoldRelease,
} from "../hooks";
import { VerifyPanel, useStepUp } from "./approval-verify";
import { PasswordField, Required } from "./recon-forms";
import type { HoldNotice } from "./recon-hold-model";
import { REASON_MAX, reasonProblem } from "./recon-model";
import { ReconCallout } from "./recon-parts";
import { reviewErrorMessage } from "./status-errors";

/** Same handling for both writes: step-up, conflict, or the refusal in words. */
function useWriteFailure(onNotice: (notice: HoldNotice) => void) {
  const t = useT();
  const stepUp = useStepUp({ acceptsPassword: true });
  const [error, setError] = React.useState<string | null>(null);
  const fail = (failure: unknown) => {
    if (stepUp.capture(failure)) return;
    if (isHoldConflict(failure)) {
      onNotice({ kind: "stale" });
      return;
    }
    // The clearance codes also answer a hold: say it in the words of a hold.
    if (failure instanceof ApiError) {
      if (failure.code === "PAYOUT_RECON_CLEAR_SELF_APPROVAL") {
        setError(t("payrollPayoutReview.reconHold.self.body"));
        return;
      }
      if (failure.code === "PAYOUT_RECON_CLEAR_REASON_INVALID") {
        setError(t("payrollPayoutReview.reconHold.propose.reasonError"));
        return;
      }
    }
    setError(reviewErrorMessage(failure, t));
  };
  return { stepUp, error, setError, fail };
}

export function HoldProposeForm({
  hold,
  onNotice,
  onClose,
}: {
  hold: PayoutReconHoldDto;
  onNotice: (notice: HoldNotice) => void;
  onClose: () => void;
}) {
  const t = useT();
  const propose = useProposeReconHoldRelease();
  const { stepUp, error, setError, fail } = useWriteFailure(onNotice);
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  // A field shows its problem once left (blur) or after a send attempt.
  const [touched, setTouched] = React.useState({
    reason: false,
    password: false,
  });
  const [attempted, setAttempted] = React.useState(false);
  const reasonId = `hold-reason-${hold.id}`;
  const passwordId = `hold-password-${hold.id}`;
  const reasonBad = touched.reason && reasonProblem(reason);
  const passwordBad = touched.password && !stepUp.active && password === "";

  const send = (proof?: string) => {
    if (propose.isPending) return;
    setError(null);
    propose.mutate(
      { holdId: hold.id, reason: reason.trim(), password: proof },
      {
        onSuccess: () => {
          stepUp.reset();
          setReason("");
          onNotice({ kind: "sent", holdId: hold.id });
          onClose();
        },
        onError: fail,
      },
    );
  };

  return (
    <div className="grid gap-4">
      <form
        noValidate
        aria-label={t("payrollPayoutReview.reconHold.propose.title")}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (stepUp.active) return;
          if (reasonProblem(reason) || password === "") {
            setTouched({ reason: true, password: true });
            setAttempted(true);
            document
              .getElementById(reasonProblem(reason) ? reasonId : passwordId)
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
            title={t("payrollPayoutReview.reconHold.propose.invalidTitle")}
          >
            {t("payrollPayoutReview.reconHold.propose.invalidBody")}
          </ReconCallout>
        )}
        <div className="grid gap-1">
          <FormField
            id={reasonId}
            required
            label={
              <Required>
                {t("payrollPayoutReview.reconHold.propose.reasonLabel")}
              </Required>
            }
            hint={t("payrollPayoutReview.reconHold.propose.reasonHint")}
            error={
              reasonBad
                ? t("payrollPayoutReview.reconHold.propose.reasonError")
                : undefined
            }
          >
            <Textarea
              name="reason"
              value={reason}
              onBlur={() => setTouched((now) => ({ ...now, reason: true }))}
              maxLength={REASON_MAX}
              rows={4}
              placeholder={t(
                "payrollPayoutReview.reconHold.propose.reasonPlaceholder",
              )}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <p className="text-right text-xs text-muted-foreground tabular">
            {t("payrollPayoutReview.reconHold.propose.counter", {
              count: reason.length,
            })}
          </p>
        </div>
        {!stepUp.active && (
          <>
            <PasswordField
              id={passwordId}
              label={t("payrollPayoutReview.reconHold.propose.passwordLabel")}
              error={t("payrollPayoutReview.reconHold.propose.passwordError")}
              value={password}
              onChange={setPassword}
              onBlur={() => setTouched((now) => ({ ...now, password: true }))}
              invalid={passwordBad}
            />
            {error && (
              <ReconCallout
                tone="danger"
                role="alert"
                title={t("payrollPayoutReview.reconHold.propose.failedTitle")}
              >
                {error}
              </ReconCallout>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="submit"
                className="min-h-11 w-full"
                loading={propose.isPending}
              >
                {t("payrollPayoutReview.reconHold.propose.submit")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                onClick={() => {
                  setPassword("");
                  stepUp.reset();
                  onClose();
                }}
              >
                {t("payrollPayoutReview.reconHold.propose.cancel")}
              </Button>
            </div>
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
        {t("payrollPayoutReview.reconHold.propose.note")}
      </p>
    </div>
  );
}

export function HoldApproveForm({
  hold,
  onNotice,
}: {
  hold: PayoutReconHoldDto;
  onNotice: (notice: HoldNotice) => void;
}) {
  const t = useT();
  const approve = useApproveReconHoldRelease();
  const { stepUp, error, setError, fail } = useWriteFailure(onNotice);
  const [password, setPassword] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const releaseId = hold.release?.id;
  const passwordId = `hold-password-${hold.id}`;
  const passwordBad = touched && !stepUp.active && password === "";

  const send = (proof?: string) => {
    if (approve.isPending || !releaseId) return;
    setError(null);
    approve.mutate(
      { releaseId, password: proof },
      {
        onSuccess: () => {
          stepUp.reset();
          onNotice({ kind: "released", holdId: hold.id });
        },
        onError: fail,
      },
    );
  };

  return (
    <div className="grid gap-4">
      <form
        noValidate
        aria-label={t("payrollPayoutReview.reconHold.approve.title")}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (stepUp.active) return;
          if (password === "") {
            setTouched(true);
            document.getElementById(passwordId)?.focus();
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
              id={passwordId}
              label={t("payrollPayoutReview.reconHold.propose.passwordLabel")}
              error={t("payrollPayoutReview.reconHold.propose.passwordError")}
              value={password}
              onChange={setPassword}
              onBlur={() => setTouched(true)}
              invalid={passwordBad}
            />
            {error && (
              <ReconCallout
                tone="danger"
                role="alert"
                title={t("payrollPayoutReview.reconHold.approve.failedTitle")}
              >
                {error}
              </ReconCallout>
            )}
            <Button
              type="submit"
              className="min-h-11 w-full"
              loading={approve.isPending}
            >
              {t("payrollPayoutReview.reconHold.approve.submit")}
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
