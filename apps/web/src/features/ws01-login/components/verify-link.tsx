// "/masuk/tautan" — the page an email sign-in link opens (PRD v1.7 §3 F3
// "Magic Link Email", alur C langkah 6). The token is spent only when the guest
// presses the button, so a mail scanner that opens links cannot use it up
// (119connect's flow, kept for the same reason), and the token stays out of
// the address bar's shared space: no referrer, noindex.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, MailX, LogIn } from "lucide-react";
import type { LoginResult } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { errorCode } from "../flow";
import { useCompleteMagicLink } from "../hooks";
import { InlineFailure, Notice } from "./shared";
import { SignedIn } from "./signed-in";

/** CHALLENGE_EXPIRED / CHALLENGE_NOT_PENDING both mean "ask for a new link". */
function isDeadLink(error: unknown): boolean {
  const code = errorCode(error);
  return code === "CHALLENGE_EXPIRED" || code === "CHALLENGE_NOT_PENDING";
}

export function VerifyLinkScreen({
  token,
  returnTo,
}: {
  token?: string;
  returnTo?: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const complete = useCompleteMagicLink();
  const [result, setResult] = useState<LoginResult | null>(null);

  useEffect(() => {
    if (!result || !returnTo) return;
    // A runtime path cannot be checked against the generated route union.
    void navigate({ to: returnTo as "/", replace: true });
  }, [result, returnTo, navigate]);

  async function submit() {
    if (!token || complete.isPending) return;
    try {
      setResult(await complete.mutateAsync(token));
    } catch {
      // Rendered from complete.error below.
    }
  }

  return (
    <div className="grid gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link to="/masuk">
            <ChevronLeft aria-hidden="true" />
            {t("login.backToOptions")}
          </Link>
        </Button>
      </div>

      <header className="grid gap-2">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {t("login.verify.heading")}
        </h1>
        <p className="text-base leading-6 text-muted-foreground">
          {t("login.verify.subtitle")}
        </p>
      </header>

      {result ? (
        <SignedIn
          session={result.session}
          mfaRequired={result.mfaRequired}
          target={returnTo}
        />
      ) : !token ? (
        <Notice
          tone="warning"
          icon={MailX}
          title={t("login.verify.missingTitle")}
          hint={t("login.verify.missingHint")}
          action={
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/masuk/email">{t("login.verify.requestNew")}</Link>
            </Button>
          }
        />
      ) : isDeadLink(complete.error) ? (
        <Notice
          tone="warning"
          icon={MailX}
          title={t("login.verify.expiredTitle")}
          hint={t("login.verify.expiredHint")}
          live
          action={
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/masuk/email">{t("login.verify.requestNew")}</Link>
            </Button>
          }
        />
      ) : (
        <section className="grid gap-4 rounded-xl border-(length:--border-w) bg-card p-card">
          <Button
            size="lg"
            className="w-full"
            loading={complete.isPending}
            onClick={() => void submit()}
          >
            <LogIn aria-hidden="true" />
            {complete.isPending
              ? t("login.verify.submitting")
              : t("login.verify.submit")}
          </Button>
          {complete.isError && (
            <InlineFailure error={complete.error} onRetry={() => void submit()} />
          )}
          <p className="text-sm leading-5 text-muted-foreground">
            {t("login.verify.note")}
          </p>
        </section>
      )}
    </div>
  );
}
