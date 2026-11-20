// "/reset-password?token=…" — the page the reset mail opens (legend-1255).
// The token is read from the address and sent in the body; it works once and
// for one hour, so a spent or expired one lands on the "ask again" state.
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, MailX } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordResetError } from "../api";
import { useResetPassword } from "../hooks";
import { InlineFailure, Notice } from "./shared";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export function ResetPasswordScreen({ token }: { token: string | undefined }) {
  const t = useT();
  const reset = useResetPassword();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  // A 400 from the API is Better Auth's INVALID_TOKEN: spent or expired.
  const tokenDead =
    !token ||
    (reset.error instanceof PasswordResetError && reset.error.status === 400);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reset.isPending || !token) return;
    const newPassword = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    if (newPassword.length < MIN_PASSWORD) {
      setFieldError(t("login.resetPassword.passwordTooShort"));
      return;
    }
    if (newPassword.length > MAX_PASSWORD) {
      setFieldError(t("login.resetPassword.passwordTooLong"));
      return;
    }
    setFieldError(undefined);
    try {
      await reset.mutateAsync({ token, newPassword });
    } catch {
      // `reset.error` renders below.
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-md grid-cols-1 gap-5">
      <header className="grid min-w-0 gap-2">
        <h1 className="font-brand type-display-xl">
          {t("login.resetPassword.newHeading")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.resetPassword.newSubtitle")}
        </p>
      </header>

      {reset.isSuccess ? (
        <Notice
          tone="success"
          icon={CheckCircle2}
          title={t("login.resetPassword.doneTitle")}
          hint={t("login.resetPassword.doneHint")}
          action={
            <Button asChild size="lg">
              <Link to="/sign-in">{t("login.resetPassword.signIn")}</Link>
            </Button>
          }
          live
        />
      ) : tokenDead ? (
        <Notice
          tone="warning"
          icon={MailX}
          title={t("login.resetPassword.invalidTitle")}
          hint={t("login.resetPassword.invalidHint")}
          action={
            <Button asChild variant="outline" size="lg">
              <Link to="/forgot-password">
                {t("login.resetPassword.requestNew")}
              </Link>
            </Button>
          }
          live
        />
      ) : (
        <Card>
          <form
            onSubmit={submit}
            className="grid gap-4"
            aria-busy={reset.isPending}
          >
            <FormField
              label={t("login.resetPassword.passwordLabel")}
              hint={t("login.resetPassword.passwordHint")}
              error={fieldError}
              required
            >
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD}
                maxLength={MAX_PASSWORD}
                autoFocus
              />
            </FormField>
            {reset.isError && <InlineFailure error={reset.error} />}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={reset.isPending}
            >
              {t("login.resetPassword.save")}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
