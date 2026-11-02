import { Link, useLocation } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import { useCurrentAuth } from "../hooks";
import { secondFactorState } from "../state";
import { MfaPanel } from "./mfa-panel";
import { SecurityStatusBand } from "./security-status-band";
import { SessionsPanel } from "./sessions-panel";

/**
 * "Keamanan akun" (bead legend-9bh, PRD §3 F6). One page for every MFA role:
 * the AUTH-05 state of this session, the enrolled second factors and the
 * device sessions that can be revoked.
 */
export function SecurityPage() {
  const t = useT();
  const { pathname } = useLocation();
  const auth = useCurrentAuth();
  const now = new Date();
  const state = auth.data ? secondFactorState(auth.data, now) : null;

  return (
    <section
      aria-labelledby="security-title"
      className="mx-auto grid w-full max-w-5xl gap-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="security-title" className="sr-only">
            {t("staffAuth.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("staffAuth.description")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      {auth.isPending ? (
        <div
          className="grid gap-4 rounded-xl border-(length:--border-w) bg-card p-card"
          aria-busy="true"
        >
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : auth.isError ? (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <ErrorState
            title={
              auth.error instanceof ApiError &&
              auth.error.code === "NETWORK_ERROR"
                ? t("staffAuth.errors.offlineTitle")
                : t("staffAuth.errors.loadTitle")
            }
            description={
              auth.error instanceof ApiError &&
              auth.error.code === "NETWORK_ERROR"
                ? t("staffAuth.errors.offlineHint")
                : t("staffAuth.errors.loadHint")
            }
            onRetry={() => void auth.refetch()}
          />
        </div>
      ) : state === null ? null : state.ended ? (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <EmptyState
            title={t("staffAuth.status.endedTitle")}
            description={t("staffAuth.status.endedHint")}
            action={
              <Button asChild>
                <Link to="/sign-in">
                  <LogIn aria-hidden="true" />
                  {t("staffAuth.verify.backToSignIn")}
                </Link>
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <SecurityStatusBand
            state={state}
            verifiedAt={auth.data.session.mfaVerifiedAt}
            returnTo={pathname}
          />
          <div className="grid gap-6">
            <MfaPanel mfaRequired={auth.data.mfaRequired} />
            <SessionsPanel mfaRequired={auth.data.mfaRequired} />
          </div>
        </>
      )}
    </section>
  );
}
