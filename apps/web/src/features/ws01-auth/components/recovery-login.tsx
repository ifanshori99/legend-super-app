import * as React from "react";
import { ChevronLeft, CircleCheck, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { recoveryLoginErrorKey } from "../errors";
import { useVerifyRecoveryCode } from "../hooks";
import {
  RECOVERY_LOW_THRESHOLD,
  checkRecoveryCode,
  formatRecoveryCodeInput,
} from "../recovery-state";

/**
 * "Pakai kode cadangan" on the second-factor login (bead legend-sw980, mockup
 * platform/mfa-recovery-sw980 states "recovery", "invalid", "success"). One
 * single-use code stands in for the authenticator code; five wrong codes lock
 * the set for 15 minutes (the API answers 429).
 */
export function RecoveryLoginCard({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  /** After the success state: leave the verification page. */
  onContinue: () => void;
}) {
  const t = useT();
  const verify = useVerifyRecoveryCode();
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus on open only with a fine pointer (desktop): on a touch screen it
  // would raise the keyboard before the person has read the page.
  React.useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches)
      inputRef.current?.focus();
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const check = checkRecoveryCode(code);
    if (!check.ok) {
      setError(t("staffAuth.recoveryLogin.incomplete"));
      return;
    }
    setError(null);
    verify.mutate(
      { code: check.code },
      { onError: (cause) => setError(t(recoveryLoginErrorKey(cause))) },
    );
  }

  if (verify.isSuccess) {
    const { remaining } = verify.data;
    return (
      <Card>
        <EmptyState
          icon={CircleCheck}
          title={t("staffAuth.recoveryLogin.successTitle")}
          description={[
            t("staffAuth.recoveryLogin.successHint"),
            remaining <= RECOVERY_LOW_THRESHOLD
              ? t("staffAuth.recoveryLogin.successLow")
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          action={
            <Button onClick={onContinue}>
              {t("staffAuth.recoveryLogin.continue")}
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h1 className="type-title">{t("staffAuth.recoveryLogin.title")}</h1>
        <CardDescription>
          {t("staffAuth.recoveryLogin.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("staffAuth.recoveryLogin.label")}
            error={error ?? undefined}
            required
          >
            <Input
              ref={inputRef}
              value={code}
              onChange={(event) => {
                setCode(formatRecoveryCodeInput(event.target.value));
                if (error) setError(null);
              }}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={11}
              className="font-mono text-lg tracking-widest uppercase"
            />
          </FormField>
          <Button type="submit" loading={verify.isPending}>
            <ShieldCheck aria-hidden="true" />
            {t("staffAuth.recoveryLogin.submit")}
          </Button>
          <Button
            type="button"
            variant="link"
            className="justify-self-start"
            onClick={onBack}
          >
            <ChevronLeft aria-hidden="true" />
            {t("staffAuth.recoveryLogin.back")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
