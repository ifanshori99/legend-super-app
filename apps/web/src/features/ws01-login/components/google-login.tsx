// "/masuk/google" — Google OAuth sign-in (PRD v1.7 §5 "/masuk/google", §3 F3
// "Pelanggan — Magic Link Email dan Google OAuth"). The API builds the provider
// URL including its browser-bound state; this page only sends the visitor
// there. Google returns to /api/auth/google/callback, which sets the session
// and redirects to the return path, so nothing here reads a callback code.
//
// A Google account has no verified WhatsApp number yet, so points stay off
// until the number is linked (AUTH-07, §3 F3 "Penautan WhatsApp").
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Globe, Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useStartGoogleLogin } from "../hooks";
import { InlineFailure, Notice } from "./shared";

export function GoogleLoginScreen({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const start = useStartGoogleLogin();
  const [redirecting, setRedirecting] = useState(false);

  async function begin() {
    if (start.isPending) return;
    try {
      const url = await start.mutateAsync(returnTo);
      setRedirecting(true);
      // A full navigation: the provider owns this step and returns to the API.
      window.location.assign(url);
    } catch {
      setRedirecting(false);
      // Rendered from start.error below.
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
          {t("login.google.heading")}
        </h1>
        <p className="text-base leading-6 text-muted-foreground">
          {t("login.google.subtitle")}
        </p>
      </header>

      <section className="grid gap-4 rounded-xl border-(length:--border-w) bg-card p-card">
        <Button
          size="lg"
          className="w-full"
          loading={start.isPending || redirecting}
          onClick={() => void begin()}
        >
          <Globe aria-hidden="true" />
          {start.isPending || redirecting
            ? t("login.google.opening")
            : t("login.google.submit")}
        </Button>
        {start.isError && (
          <InlineFailure
            error={start.error}
            onRetry={() => void begin()}
          />
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.google.privacy")}
        </p>
      </section>

      <Notice
        tone="info"
        icon={Info}
        title={t("login.google.pointsTitle")}
        hint={t("login.google.pointsNote")}
      />
    </div>
  );
}
