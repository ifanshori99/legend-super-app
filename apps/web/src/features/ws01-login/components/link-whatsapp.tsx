// "/masuk/hubungkan" — attach a WhatsApp number to the signed-in account (PRD
// v1.7 §3 F3 "Penautan WhatsApp": a guest who signed in with email or Google
// links the number through the same reverse OTP before collecting or redeeming
// points; AUTH-07). The prompt states why the number is needed and that the
// bonus is tenant configuration, not a number this screen invents.
//
// States: checking the account → signed out → number already verified → link
// the number → linked. The signed-out state is the page's empty state.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Coins, ShieldCheck, UserRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/feedback-state";
import { errorCode, loginErrorKey, MEMBER_RETURN_DEFAULT } from "../flow";
import { useCurrentAuth } from "../hooks";
import { loginKeys } from "../queries";
import { Notice } from "./shared";
import { WhatsAppLogin } from "./whatsapp-login";

// `returnTo` is the member screen the visitor came from (already validated by
// the route); linking sends them back there, else to the member home.
export function LinkWhatsAppScreen({ returnTo }: { returnTo?: string }) {
  const back = returnTo ?? MEMBER_RETURN_DEFAULT;
  const t = useT();
  const queryClient = useQueryClient();
  const auth = useCurrentAuth();
  const [linked, setLinked] = useState(false);

  async function onLinked() {
    setLinked(true);
    await queryClient.invalidateQueries({ queryKey: loginKeys.currentAuth() });
  }

  return (
    <div className="mx-auto grid w-full max-w-md gap-5">
      <header className="grid gap-2">
        <p className="type-eyebrow text-muted-foreground">
          {t("login.link.eyebrow")}
        </p>
        <h1 className="font-brand type-display-xl">
          {t("login.link.heading")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("login.link.subtitle")}
        </p>
      </header>

      {linked ? (
        <Notice
          tone="success"
          icon={ShieldCheck}
          title={t("login.link.successTitle")}
          hint={t("login.link.successHint")}
          live
          action={
            <Button asChild size="lg" className="w-full sm:w-auto">
              <a href={back}>{t("login.link.continue")}</a>
            </Button>
          }
        />
      ) : auth.isPending ? (
        <Card role="status" aria-busy="true" className="gap-3">
          <span className="sr-only">{t("login.link.verifying")}</span>
          <Skeleton className="h-6 w-2/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-control-lg w-full" />
        </Card>
      ) : auth.isError ? (
        errorCode(auth.error) === "UNAUTHORIZED" ? (
          <Notice
            tone="info"
            icon={UserRound}
            title={t("login.link.signedOutTitle")}
            hint={t("login.link.signedOutHint")}
            action={
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link to="/masuk">{t("login.link.signedOutAction")}</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState
            title={t("login.link.errorTitle")}
            description={t(loginErrorKey(auth.error))}
            onRetry={() => void auth.refetch()}
          />
        )
      ) : auth.data.whatsAppVerified ? (
        <Notice
          tone="success"
          icon={ShieldCheck}
          title={t("login.link.verifiedTitle")}
          hint={t("login.link.verifiedHint")}
          live
          action={
            <Button asChild size="lg" className="w-full sm:w-auto">
              <a href={back}>{t("login.link.verifiedAction")}</a>
            </Button>
          }
        />
      ) : (
        <>
          <Notice
            tone="info"
            icon={Coins}
            title={t("login.link.whyTitle")}
            hint={
              <div className="grid gap-1.5">
                <p>{t("login.link.whyBody")}</p>
                <p>{t("login.link.bonusNote")}</p>
              </div>
            }
          />
          <Card className="gap-4">
            <WhatsAppLogin
              copy={{
                heading: t("login.link.panelHeading"),
                hint: t("login.whatsapp.hint"),
                action: t("login.link.action"),
              }}
              onSignedIn={() => void onLinked()}
            />
          </Card>
        </>
      )}
    </div>
  );
}
