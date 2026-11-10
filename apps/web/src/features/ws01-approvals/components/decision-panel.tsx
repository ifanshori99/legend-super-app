// Approve / reject with a reason (PRD §3 F7 Kotak Approval). Handles the
// states an approver can hit: own request (AUTH-06), deadline passed, no
// permission, and the MFA step-up (AUTH-05) when the session owes a second
// factor. Actions sit in a sticky bar so they stay at thumb reach on phones.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Check, ShieldCheck, X } from "lucide-react";
import type { ApprovalRequest } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import {
  useCurrentAuth,
  useDecide,
  useTotpFactor,
  useVerifyFactor,
} from "../hooks";
import {
  REASON_MAX,
  decisionBlock,
  decisionBlockKey,
  errorMessageKey,
  isSelfApproval,
  needsStepUp,
  reasonProblem,
  rejectBlock,
} from "../logic.ts";

type Decision = "approved" | "rejected";

export function DecisionPanel({
  request,
  canDecide,
  now,
  onDecided,
}: {
  request: ApprovalRequest;
  canDecide: boolean;
  now: number;
  onDecided?: (request: ApprovalRequest) => void;
}) {
  const t = useT();
  const toast = useToast();
  const auth = useCurrentAuth();
  const decide = useDecide(request.id);
  const verify = useVerifyFactor();

  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [pending, setPending] = React.useState<Decision | null>(null);
  const [stepUp, setStepUp] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [verified, setVerified] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  // One key per decision attempt: the same decision + reason retried (lost
  // response, step-up resend, double tap) reuses it, so the service applies
  // it once. A changed decision or reason is a new attempt.
  const attempt = React.useRef<{ fingerprint: string; key: string } | null>(
    null,
  );

  const view = auth.data?.data;
  const blockInput = {
    request,
    currentUserId: view?.user.id ?? null,
    canDecide,
    mfaEnrollmentRequired: view?.mfaEnrollmentRequired ?? false,
    now,
  };
  const block = decisionBlock(blockInput);
  // Sole Owner on their own request: "Setujui" is live, "Tolak" stays shut.
  const selfApproving =
    block === null && isSelfApproval(request, blockInput.currentUserId);
  const rejectBlocked = rejectBlock(blockInput) !== null;
  const factor = useTotpFactor(stepUp);
  const problem = reasonProblem(reason);

  const submit = (decision: Decision) => {
    if (decide.isPending) return;
    setError(null);
    setPending(decision);
    const body = { decision, reason: reason.trim() };
    const fingerprint = `${decision}\n${body.reason}`;
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newIdempotencyKey() };
    decide.mutate(
      { body, idempotencyKey: attempt.current.key },
      {
        onSuccess: ({ data }) => {
          attempt.current = null;
          toast({
            title: t(
              decision === "approved"
                ? "approvals.toast.approved"
                : "approvals.toast.rejected",
            ),
            tone: "success",
          });
          setStepUp(false);
          onDecided?.(data);
        },
        onError: (failure) => {
          const code = failure instanceof ApiError ? failure.code : undefined;
          if (code === "MFA_REQUIRED") {
            setPending(decision);
            setStepUp(true);
            setVerified(false);
            return;
          }
          setError(t(errorMessageKey(code)));
        },
      },
    );
  };

  const choose = (decision: Decision) => {
    setTouched(true);
    if (problem) return;
    if (view && needsStepUp(view) && !verified) {
      setPending(decision);
      setStepUp(true);
      return;
    }
    submit(decision);
  };

  const verifyCode = () => {
    if (!factor.totp) return;
    if (!/^\d{6}$/.test(code)) {
      setCodeError(t("approvals.stepUp.codeInvalid"));
      return;
    }
    setCodeError(null);
    verify.mutate(
      { factorId: factor.totp.id, code },
      {
        onSuccess: () => {
          setVerified(true);
          setStepUp(false);
          setCode("");
          if (pending) submit(pending);
        },
        onError: (failure) =>
          setCodeError(
            t(
              errorMessageKey(
                failure instanceof ApiError ? failure.code : undefined,
              ),
            ),
          ),
      },
    );
  };

  if (block === "notPending") return null;

  return (
    <section
      aria-label={t("approvals.decision.title")}
      className="grid gap-3"
      data-testid="decision-panel"
    >
      <h3 className="type-title">{t("approvals.decision.title")}</h3>

      {block && (
        <div
          role="status"
          data-blocked={block}
          className="grid gap-1 rounded-container border-(length:--border-w) bg-surface-2 p-3"
        >
          <p className="text-sm font-semibold">{t(decisionBlockKey(block))}</p>
          {block === "own" && (
            <p className="text-sm text-muted-foreground">
              {t("approvals.blocked.ownHint")}
            </p>
          )}
          {block === "expired" && (
            <p className="text-sm text-muted-foreground">
              {t("approvals.blocked.expiredHint")}
            </p>
          )}
          {block === "enrollment" && (
            <Link
              to="/kelola/keamanan"
              className="text-sm font-semibold text-primary underline underline-offset-4"
            >
              {t("approvals.blocked.enrollmentAction")}
            </Link>
          )}
        </div>
      )}

      {stepUp && !block && (
        <div
          role="group"
          aria-label={t("approvals.stepUp.title")}
          data-testid="mfa-step-up"
          className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t("approvals.stepUp.title")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("approvals.stepUp.hint")}
          </p>
          {factor.isPending ? (
            <p className="text-sm">{t("common.loading")}</p>
          ) : factor.totp ? (
            <>
              <FormField
                label={t("approvals.stepUp.code")}
                error={codeError ?? undefined}
                required
              >
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  className="tabular tracking-[0.3em]"
                />
              </FormField>
              <Button
                type="button"
                loading={verify.isPending || decide.isPending}
                disabled={code.length !== 6}
                onClick={verifyCode}
              >
                {t("approvals.stepUp.verify")}
              </Button>
            </>
          ) : (
            <p className="text-sm">{t("approvals.stepUp.noFactor")}</p>
          )}
        </div>
      )}

      {selfApproving && (
        <p
          data-testid="self-approval-note"
          className="text-sm text-muted-foreground"
        >
          {t("approvals.selfApproval.note")}
        </p>
      )}

      <FormField
        label={t("approvals.decision.reason")}
        hint={t("approvals.decision.reasonHint")}
        error={
          touched && problem
            ? t(
                problem === "short"
                  ? "approvals.decision.reasonShort"
                  : "approvals.decision.reasonLong",
              )
            : undefined
        }
        required
      >
        <Textarea
          value={reason}
          maxLength={REASON_MAX + 50}
          disabled={block !== null}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </FormField>

      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}

      <div className="sticky bottom-0 -mx-card flex gap-2 border-t bg-card px-card pt-3 pb-1">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 flex-1"
          disabled={rejectBlocked || decide.isPending}
          loading={decide.isPending && pending === "rejected"}
          onClick={() => choose("rejected")}
        >
          <X aria-hidden="true" />
          {t("approvals.decision.reject")}
        </Button>
        <Button
          type="button"
          className="min-h-11 flex-1"
          disabled={block !== null || decide.isPending}
          loading={decide.isPending && pending === "approved"}
          onClick={() => choose("approved")}
        >
          <Check aria-hidden="true" />
          {t("approvals.decision.approve")}
        </Button>
      </div>
    </section>
  );
}
