// "/masuk" — the customer and staff sign-in entry (PRD v1.7 §5 "/masuk",
// §3 F3, §4 Alur C; AUTH-01/AUTH-03). WhatsApp reverse OTP is the primary
// method; a magic link and Google are the alternatives for guests who prefer
// them. The anti-phishing warning sits next to the methods, because the code
// it protects is shown right above it.
//
// A signed-in visitor continues to the page they came from (`?lanjut=` or the
// `?redirect=` alias captive portals use), or to their profile home. A staff
// session that still needs its second factor goes to the dashboard, whose
// guard shows the AUTH-05 screen (bead legend-9bh owns the MFA screens).
import { useEffect, useState } from "react";
import { endActingStaffMode } from "@/lib/api/acting-staff";
import { Link, useNavigate } from "@tanstack/react-router";
import { Globe, Mail, ShieldAlert } from "lucide-react";
import type { Session } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { postLoginPath, safeReturnPath } from "../flow";
import { Notice } from "./shared";
import { SignedIn } from "./signed-in";
import { WhatsAppLogin } from "./whatsapp-login";

// At 320px the labels ("Masuk dengan tautan email") are wider than the card,
// and a nowrap button sets the grid's min-content (legend-rxida). Let the
// label wrap on phones; from sm up the button keeps its single-line pill.
const WRAP_BUTTON =
  "h-auto! min-h-control-lg px-4 py-2 text-center whitespace-normal sm:px-8";

export function SignInScreen({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const brand = t("app.defaultBrand");
  const [result, setResult] = useState<{
    session: Session;
    mfaRequired: boolean;
  } | null>(null);
  // The route already validated the search; re-check here so no future caller
  // can feed an open redirect into navigate() or the success link.
  const safeReturnTo = safeReturnPath(returnTo);

  const target = result
    ? (safeReturnTo ?? postLoginPath(result.session))
    : null;

  // Arriving from a page means the guest wanted that page back. `href` keeps
  // the query intact (e.g. `/wifi?zone=…&table=…`), which `to` would read as
  // part of the path.
  // A new login (password, WhatsApp) starts without the previous one's POS
  // cashier hold.
  useEffect(() => {
    if (result) endActingStaffMode();
  }, [result]);

  useEffect(() => {
    if (!result || !safeReturnTo) return;
    void navigate({ href: safeReturnTo, replace: true });
  }, [result, safeReturnTo, navigate]);

  return (
    <div className="mx-auto grid w-full max-w-md grid-cols-1 gap-5">
      <header className="grid min-w-0 gap-2">
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
          <Card className="min-w-0 gap-5">
            <WhatsAppLogin
              copy={{
                heading: t("login.whatsapp.heading"),
                hint: t("login.whatsapp.hint"),
                action: t("login.whatsapp.action"),
              }}
              returnTo={safeReturnTo}
              onSignedIn={setResult}
            />

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="type-eyebrow text-muted-foreground">
                {t("login.or")}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
            <div className="grid grid-cols-1 gap-2">
              <Button
                asChild
                variant="outline"
                size="lg"
                className={WRAP_BUTTON}
              >
                <Link to="/masuk/email" search={{ lanjut: safeReturnTo }}>
                  <Mail aria-hidden="true" />
                  {t("login.email.action")}
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className={WRAP_BUTTON}
              >
                <Link to="/masuk/google" search={{ lanjut: safeReturnTo }}>
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
