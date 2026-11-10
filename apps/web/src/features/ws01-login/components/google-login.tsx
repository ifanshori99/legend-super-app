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
import { endActingStaffMode } from "@/lib/api/acting-staff";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      // The success comes back through an API redirect with no client code
      // to run, so the POS cashier hold of this tab is lifted before leaving.
      endActingStaffMode();
      window.location.assign(url);
    } catch {
      setRedirecting(false);
      // Rendered from start.error below.
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
          {t("login.google.heading")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.google.subtitle")}
        </p>
      </header>

      <Card className="gap-4">
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
          <InlineFailure error={start.error} onRetry={() => void begin()} />
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.google.privacy")}
        </p>
      </Card>

      <Notice
        tone="info"
        icon={Info}
        title={t("login.google.pointsTitle")}
        hint={t("login.google.pointsNote")}
      />
    </div>
  );
}
