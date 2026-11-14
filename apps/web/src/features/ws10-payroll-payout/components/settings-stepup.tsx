// Second-factor step-up for saving a payout config. The server asks for it
// (MFA_REQUIRED); after the code is accepted the parent resends the same save.
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useTotpFactor, useVerifyFactor } from "../../ws01-approvals/hooks";

export function SettingsStepUp({
  saving,
  onVerified,
}: {
  /** The resent save is in flight. */
  saving: boolean;
  onVerified: () => void;
}) {
  const t = useT();
  const factor = useTotpFactor(true);
  const verify = useVerifyFactor();
  const [code, setCode] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);

  const submit = () => {
    if (!factor.totp) return;
    if (!/^\d{6}$/.test(code)) {
      setProblem(t("payrollPayoutSettings.stepUp.codeInvalid"));
      return;
    }
    setProblem(null);
    verify.mutate(
      { factorId: factor.totp.id, code },
      {
        onSuccess: () => {
          setCode("");
          onVerified();
        },
        onError: () =>
          setProblem(t("payrollPayoutSettings.stepUp.codeRejected")),
      },
    );
  };

  return (
    <div
      role="group"
      aria-label={t("payrollPayoutSettings.stepUp.title")}
      data-testid="payout-settings-step-up"
      className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4" aria-hidden="true" />
        {t("payrollPayoutSettings.stepUp.title")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("payrollPayoutSettings.stepUp.hint")}
      </p>
      {factor.isPending ? (
        <p className="text-sm" role="status">
          {t("payrollPayoutSettings.stepUp.loading")}
        </p>
      ) : factor.totp ? (
        <>
          <FormField
            label={t("payrollPayoutSettings.stepUp.code")}
            error={problem ?? undefined}
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
            className="min-h-11"
            loading={verify.isPending || saving}
            disabled={code.length !== 6}
            onClick={submit}
          >
            {t("payrollPayoutSettings.stepUp.verify")}
          </Button>
        </>
      ) : (
        <p className="text-sm">{t("payrollPayoutSettings.stepUp.noFactor")}</p>
      )}
    </div>
  );
}
