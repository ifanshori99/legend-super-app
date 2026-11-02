// "/masuk/email" — magic-link sign-in (PRD v1.7 §5 "/masuk/email", §3 F3
// "Pelanggan — Magic Link Email dan Google OAuth"). The answer never reveals
// whether the address has an account: the same panel appears either way, and
// the link itself arrives by email.
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, MailCheck, Send } from "lucide-react";
import { createMagicLinkChallengeSchema } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useRequestMagicLink } from "../hooks";
import { InlineFailure, Notice } from "./shared";

export function EmailLoginScreen({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const request = useRequestMagicLink();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.isPending) return;
    const raw = String(new FormData(event.currentTarget).get("email") ?? "");
    const email = raw.trim().toLowerCase();
    // The form applies the endpoint's own body rule before the call, so a typo
    // is fixed next to the field instead of becoming an API error.
    const parsed = createMagicLinkChallengeSchema.safeParse(
      returnTo ? { email, returnTo } : { email },
    );
    if (!parsed.success) {
      setFieldError(
        fieldErrors(parsed.error).email ?? t("login.errors.invalidEmail"),
      );
      return;
    }
    setFieldError(undefined);
    try {
      await request.mutateAsync({ email, returnTo });
      setSentTo(email);
    } catch {
      // Rendered from request.error below.
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-md gap-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3 min-h-11">
          <Link to="/masuk">
            <ChevronLeft aria-hidden="true" />
            {t("login.backToOptions")}
          </Link>
        </Button>
      </div>

      <header className="grid gap-2">
        <h1 className="font-brand type-display-xl">
          {t("login.email.heading")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.email.subtitle")}
        </p>
      </header>

      {sentTo ? (
        <div className="grid gap-4">
          <Notice
            tone="info"
            icon={MailCheck}
            title={t("login.email.sentTitle")}
            hint={
              <div className="grid gap-1.5">
                <p>{t("login.email.sentBody", { email: sentTo })}</p>
                <p>{t("login.email.checkSpam")}</p>
              </div>
            }
            live
          />
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => {
              request.reset();
              setSentTo(null);
            }}
          >
            {t("login.email.resend")}
          </Button>
        </div>
      ) : (
        <Card>
          <form
            onSubmit={submit}
            className="grid gap-4"
            aria-busy={request.isPending}
          >
            <FormField
              label={t("login.email.addressLabel")}
              hint={t("login.email.addressHint")}
              error={fieldError}
              required
            >
              <Input
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t("login.email.addressPlaceholder")}
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
              {t("login.email.submit")}
            </Button>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("login.email.privacy")}
            </p>
          </form>
        </Card>
      )}
    </div>
  );
}
