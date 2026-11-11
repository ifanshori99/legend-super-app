// "/undangan" — the page the first-admin invitation email opens (legend-fy5y).
// The token and tenant id travel in the URL fragment, so neither reaches a
// server log. The page posts them once; the API only marks the email verified
// and issues no session.
import { useEffect, useRef } from "react";
import { CheckCircle2, MailX } from "lucide-react";
import { invitationAcceptBodySchema } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { useAcceptInvitation } from "../hooks";
import { Notice } from "./shared";

/** Reads `#token=…&tenant=…`; null when either part is missing or malformed. */
function readInvitation() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const parsed = invitationAcceptBodySchema.safeParse({
    token: params.get("token"),
    tenantId: params.get("tenant"),
  });
  return parsed.success ? parsed.data : null;
}

export function AcceptInvitationScreen() {
  const t = useT();
  const accept = useAcceptInvitation();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const body = readInvitation();
    // The secret leaves the address bar and history as soon as it is read.
    window.history.replaceState(null, "", window.location.pathname);
    // An incomplete link is as dead as an expired one: same notice below.
    accept.mutate(body);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, []);

  return (
    <div className="mx-auto grid w-full max-w-md gap-5 p-4">
      <header className="grid gap-2">
        <h1 className="font-brand type-display-xl">
          {t("login.invitation.heading")}
        </h1>
      </header>
      {accept.isSuccess ? (
        <Notice
          tone="success"
          icon={CheckCircle2}
          title={t("login.invitation.doneTitle")}
          hint={t("login.invitation.doneHint")}
          live
        />
      ) : accept.isError ? (
        <Notice
          tone="warning"
          icon={MailX}
          title={t("login.invitation.deadTitle")}
          hint={t("login.invitation.deadHint")}
          live
        />
      ) : (
        <Card className="gap-4 p-card">
          <p className="text-sm leading-5 text-muted-foreground" role="status">
            {t("login.invitation.checking")}
          </p>
        </Card>
      )}
    </div>
  );
}
