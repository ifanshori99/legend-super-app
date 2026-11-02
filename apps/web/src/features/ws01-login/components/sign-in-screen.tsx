// "/masuk" — the customer and staff sign-in entry (PRD v1.7 §5 "/masuk",
// §3 F3, §4 Alur C; AUTH-01/AUTH-03). WhatsApp reverse OTP is the primary
// method; a magic link and Google are the alternatives for guests who prefer
// them. The anti-phishing warning sits next to the methods, because the code
// it protects is shown right above it.
//
// A signed-in visitor continues to the page they came from (`?lanjut=`), or to
// their profile home. A staff session that still needs its second factor goes
// to the dashboard, whose guard shows the AUTH-05 screen (bead legend-9bh owns
// the MFA screens).
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Globe, Mail, ShieldAlert } from "lucide-react";
import type { Session } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { postLoginPath } from "../flow";
import { Notice } from "./shared";
import { SignedIn } from "./signed-in";
import { WhatsAppLogin } from "./whatsapp-login";

export function SignInScreen({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const brand = t("app.defaultBrand");
  const [result, setResult] = useState<{
    session: Session;
    mfaRequired: boolean;
  } | null>(null);

  const target = result ? (returnTo ?? postLoginPath(result.session)) : null;

  // Arriving from a page means the guest wanted that page back.
  useEffect(() => {
    if (!result || !returnTo) return;
    // A runtime path cannot be checked against the generated route union.
    void navigate({ to: returnTo as "/", replace: true });
  }, [result, returnTo, navigate]);

  return (
    <div className="mx-auto grid w-full max-w-md gap-5">
      <header className="grid gap-2">
        <p className="type-eyebrow text-muted-foreground">
          {t("login.eyebrow")}
        </p>
        <h1 className="font-brand type-display-xl">
          {t("login.heading", { brand })}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.subtitle")}
        </p>
      </header>

      {result && target ? (
        <SignedIn
          session={result.session}
          mfaRequired={result.mfaRequired}
          target={target}
        />
      ) : (
        <>
          <Card className="gap-5">
            <WhatsAppLogin
              copy={{
                heading: t("login.whatsapp.heading"),
                hint: t("login.whatsapp.hint"),
                action: t("login.whatsapp.action"),
              }}
              returnTo={returnTo}
              onSignedIn={setResult}
            />

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="type-eyebrow text-muted-foreground">
                {t("login.or")}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
            <div className="grid gap-2">
              <Button asChild variant="outline" size="lg">
                <Link to="/masuk/email" search={{ lanjut: returnTo }}>
                  <Mail aria-hidden="true" />
                  {t("login.email.action")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link to="/masuk/google" search={{ lanjut: returnTo }}>
                  <Globe aria-hidden="true" />
                  {t("login.google.action")}
                </Link>
              </Button>
            </div>
          </Card>

          <Notice
            tone="warning"
            icon={ShieldAlert}
            title={t("login.phishing.title")}
            hint={
              <div className="grid gap-1.5">
                <p>{t("login.phishing.body", { brand })}</p>
                <p>{t("login.phishing.mismatch")}</p>
              </div>
            }
          />
        </>
      )}
    </div>
  );
}
