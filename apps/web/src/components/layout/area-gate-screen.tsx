import { Link, useLocation } from "@tanstack/react-router";
import { LockKeyhole, ShieldAlert, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { AREAS, type AreaKey } from "@/lib/areas/definitions";
import type { AreaGate } from "@/lib/areas/guard";

/**
 * Shown instead of an area when the visitor is signed in but may not open it
 * (RBAC §3.7) or still owes the second factor (AUTH-05). No navigation is
 * rendered, so the screen does not reveal what the area contains. The API
 * refuses the same requests regardless.
 */
export function AreaGateScreen({
  area,
  gate,
}: {
  area: AreaKey;
  gate: Exclude<AreaGate, { status: "allowed" | "unauthenticated" }>;
}) {
  const t = useT();
  const { pathname } = useLocation();
  const definition = AREAS[area];
  const mfa = gate.status === "mfa_required";
  return (
    <ThemeScope
      density={definition.density}
      mode={definition.forcedMode}
      className="grid min-h-dvh place-items-center px-gutter"
    >
      <main id="main-content" className="w-full max-w-md">
        <EmptyState
          icon={mfa ? LockKeyhole : ShieldAlert}
          title={t(mfa ? "gate.mfaTitle" : "gate.forbiddenTitle")}
          description={t(mfa ? "gate.mfaHint" : "gate.forbiddenHint")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {mfa && (
                <Button asChild>
                  <Link to="/verifikasi" search={{ returnTo: pathname }}>
                    <ShieldCheck aria-hidden="true" />
                    {t("gate.mfaVerify")}
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline">
                <Link to="/">{t("gate.backHome")}</Link>
              </Button>
            </div>
          }
        />
      </main>
    </ThemeScope>
  );
}
