// Step-up for payout money actions: the server answers MFA_REQUIRED or
// REAUTH_REQUIRED, this panel collects the authenticator code and/or the
// account password and the caller retries. The server stays the checker; the
// panel only gathers the proof and never decides anything.
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/errors";
import {
  useTotpFactor,
  useVerifyFactor,
} from "@/features/ws01-approvals/hooks";

export type StepUpNeeds = { mfa: boolean; password: boolean };

/**
 * Remembers which proof the server asked for. `capture(error)` returns true
 * when the error is a step-up request (the panel then shows); any other error
 * (including a wrong password) returns false so the caller shows it.
 *
 * REAUTH_REQUIRED (401) means the MFA stamp is stale, or, on endpoints that
 * take a password, that no password came with a stamp earned at enrollment.
 * The code cannot tell the two apart, so the panel asks for a fresh code; a
 * fresh code satisfies both. Only endpoints that accept `password`
 * (`acceptsPassword`) also offer it, as the alternative proof.
 */
export function useStepUp(options: { acceptsPassword?: boolean } = {}) {
  const acceptsPassword = options.acceptsPassword ?? false;
  const [needs, setNeeds] = React.useState<StepUpNeeds>({
    mfa: false,
    password: false,
  });
  const [round, setRound] = React.useState(0);
  const capture = (error: unknown): boolean => {
    if (!(error instanceof ApiError)) return false;
    if (error.code === "MFA_REQUIRED" || error.code === "REAUTH_REQUIRED") {
      setNeeds({ mfa: true, password: acceptsPassword });
      setRound((value) => value + 1);
      return true;
    }
    if (error.code === "REAUTH_PASSWORD_INVALID" && acceptsPassword) {
      setNeeds({ mfa: true, password: true });
      setRound((value) => value + 1);
    }
    return false;
  };
  const reset = () => setNeeds({ mfa: false, password: false });
  return {
    needs,
    round,
    active: needs.mfa || needs.password,
    capture,
    reset,
  };
}

export function VerifyPanel({
  needs,
  busy,
  error,
  onVerified,
  onCancel,
}: {
  needs: StepUpNeeds;
  busy: boolean;
  /** Server refusal of the retried action, shown in place. */
  error?: string | null;
  /** The proof is ready: retry the action (password only when asked). */
  onVerified: (password?: string) => void;
  /** Leave the step-up without sending anything. */
  onCancel?: () => void;
}) {
  const t = useT();
  const factor = useTotpFactor(needs.mfa);
  const verify = useVerifyFactor();
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [mfaDone, setMfaDone] = React.useState(false);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);

  const needsCode = needs.mfa && !mfaDone;
  const noFactor =
    needs.mfa && !needs.password && !factor.isPending && !factor.totp;

  const working = busy || verify.isPending;
  const submit = () => {
    if (working || noFactor) return;
    setCodeError(null);
    setPasswordError(null);
    const finish = (withPassword: boolean) =>
      onVerified(withPassword ? password : undefined);
    const wantsCode = needsCode && code.length > 0;
    const wantsPassword = needs.password && password.length > 0;
    if (wantsCode) {
      if (!/^\d{6}$/.test(code)) {
        setCodeError(t("payrollPayoutReview.verify.codeInvalid"));
        return;
      }
      if (!factor.totp) return;
      verify.mutate(
        { factorId: factor.totp.id, code },
        {
          onSuccess: () => {
            setMfaDone(true);
            setCode("");
            finish(wantsPassword);
          },
          onError: () =>
            setCodeError(t("payrollPayoutReview.verify.codeRejected")),
        },
      );
      return;
    }
    if (wantsPassword || (!needsCode && !needs.password)) {
      finish(wantsPassword);
      return;
    }
    if (needs.password) {
      setPasswordError(t("payrollPayoutReview.verify.either"));
      return;
    }
    setCodeError(t("payrollPayoutReview.verify.codeInvalid"));
  };

  // The first field takes focus when it appears: the code, else the password.
  const codeFirst = needsCode && Boolean(factor.totp);
  return (
    <form
      aria-label={t("payrollPayoutReview.verify.title")}
      data-testid="payout-verify"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="grid gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4" aria-hidden="true" />
        {t("payrollPayoutReview.verify.title")}
      </p>
      {needs.mfa && (
        <p className="text-sm text-muted-foreground">
          {t("payrollPayoutReview.verify.mfaHint")}
        </p>
      )}
      {needs.password && (
        <p className="text-sm text-muted-foreground">
          {t(
            needs.mfa
              ? "payrollPayoutReview.verify.orPassword"
              : "payrollPayoutReview.verify.passwordHint",
          )}
        </p>
      )}
      {needs.mfa && factor.isPending && (
        <p className="text-sm">
          {t("payrollPayoutReview.verify.loadingFactor")}
        </p>
      )}
      {noFactor && (
        <p role="alert" className="text-sm font-medium text-danger">
          {t("payrollPayoutReview.verify.noFactor")}
        </p>
      )}
      {needsCode && factor.totp && (
        <FormField
          label={t("payrollPayoutReview.verify.code")}
          error={codeError ?? undefined}
          required={!needs.password}
        >
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            spellCheck={false}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            className="tabular min-h-11 tracking-[0.3em]"
          />
        </FormField>
      )}
      {needs.password && (
        <FormField
          label={t("payrollPayoutReview.verify.password")}
          error={passwordError ?? undefined}
          required={!needs.mfa}
        >
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus={!codeFirst}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-11"
          />
        </FormField>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="min-h-11"
          loading={working}
          disabled={noFactor}
        >
          {t("payrollPayoutReview.verify.submit")}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={working}
            onClick={onCancel}
          >
            {t("payrollPayoutReview.verify.cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}
