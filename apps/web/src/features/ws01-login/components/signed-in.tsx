// The settled state after a session exists: the profile home (customer) or the
// dashboard (staff), with the AUTH-05 note when the role still needs its second
// factor. Shared by /masuk and /masuk/tautan so both flows end the same way.
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import type { Session } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { postLoginPath } from "../flow";
import { Notice, SuccessPanel } from "./shared";

export function SignedIn({
  session,
  mfaRequired,
  target,
}: {
  session: Session;
  mfaRequired: boolean;
  /** Where "continue" goes: the return path, else the profile home. */
  target?: string;
}) {
  const t = useT();
  const staff = session.kind === "management";
  const href = target ?? postLoginPath(session);
  return (
    <div className="grid gap-4">
      <SuccessPanel
        title={t("login.whatsapp.successTitle")}
        hint={
          mfaRequired
            ? t("login.mfaRequiredHint")
            : t("login.whatsapp.successHint")
        }
        action={
          <Button asChild size="lg">
            {/* A runtime path cannot be checked against the route union. */}
            <Link to={href as "/"}>
              <ShieldCheck aria-hidden="true" />
              {staff ? t("login.toDashboard") : t("login.toMember")}
            </Link>
          </Button>
        }
      />
      {mfaRequired && (
        <Notice
          tone="info"
          icon={ShieldCheck}
          title={t("login.mfaRequiredTitle")}
          hint={t("login.mfaRequiredHint")}
        />
      )}
    </div>
  );
}
