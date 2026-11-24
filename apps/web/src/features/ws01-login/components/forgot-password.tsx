// "/forgot-password" — asks for the reset mail (legend-1255). The answer never
// says whether the address has an account: one panel for every email. When the
// deployment cannot send mail (SMTP not set up) the page says so instead of
// promising a mail that will never arrive.
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, MailCheck, MailX, Send } from "lucide-react";
import { createMagicLinkChallengeSchema } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordResetError } from "../api";
import { usePasswordResetEnabled, useRequestPasswordReset } from "../hooks";
import { InlineFailure, Notice } from "./shared";

export function ForgotPasswordScreen() {
  const t = useT();
  const enabled = usePasswordResetEnabled();
  const request = useRequestPasswordReset();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  // The status said "on" but the request itself answered 503: show the same
  // "not available" state rather than a generic failure.
  const unavailable =
    enabled === false ||
    (request.error instanceof PasswordResetError &&
      request.error.status === 503);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.isPending) return;
    const raw = String(new FormData(event.currentTarget).get("email") ?? "");
    const email = raw.trim().toLowerCase();
    // Same email rule as the magic-link form: a typo is fixed beside the field.
    const parsed = createMagicLinkChallengeSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldError(t("login.errors.invalidEmail"));
      return;
    }
    setFieldError(undefined);
    try {
      await request.mutateAsync(email);
      setSentTo(email);
    } catch {
      // `request.error` renders below.
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-md grid-cols-1 gap-5">
      <Button asChild variant="link" size="sm" className="justify-self-start">
        <Link to="/sign-in">
          <ChevronLeft aria-hidden="true" />
          {t("login.resetPassword.backToSignIn")}
        </Link>
      </Button>
      <header className="grid min-w-0 gap-2">
        <h1 className="font-brand type-display-xl">
          {t("login.resetPassword.forgotHeading")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.resetPassword.forgotSubtitle")}
        </p>
      </header>

      {unavailable ? (
        <Notice
          tone="warning"
          icon={MailX}
          title={t("login.resetPassword.unavailableTitle")}
          hint={t("login.resetPassword.unavailableHint")}
          live
        />
      ) : sentTo ? (
        <Notice
          tone="info"
          icon={MailCheck}
          title={t("login.resetPassword.sentTitle")}
          hint={
            <div className="grid gap-1.5">
              <p>{t("login.resetPassword.sentBody", { email: sentTo })}</p>
              <p>{t("login.resetPassword.checkSpam")}</p>
            </div>
          }
          live
        />
      ) : (
        <Card>
          <form
            onSubmit={submit}
            className="grid gap-4"
            aria-busy={request.isPending}
          >
            <FormField
              label={t("login.resetPassword.emailLabel")}
              error={fieldError}
              required
            >
              <Input
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t("login.resetPassword.emailPlaceholder")}
                required
                maxLength={254}
                autoFocus
              />
            </FormField>
            {request.isError && <InlineFailure error={request.error} />}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={request.isPending}
            >
              <Send aria-hidden="true" />
              {t("login.resetPassword.submit")}
            </Button>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("login.resetPassword.privacy")}
            </p>
          </form>
        </Card>
      )}
    </div>
  );
}
