import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CircleCheck,
  Info,
  KeyRound,
  LogIn,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import type { MfaFactor } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { secondFactorErrorKey } from "../errors";
import { useCurrentAuth, useVerifyMfa } from "../hooks";
import {
  asAppPath,
  isTotpCodeComplete,
  normalizeTotpCode,
  primaryIdentity,
  secondFactorState,
} from "../state";
import { TotpEnrollFlow } from "./totp-enroll";

/**
 * The code form for this session (AUTH-05). The contract verifies a TOTP code;
 * passkey factors are listed with an honest hint until assertion verification
 * lands in the API (bead legend-jemg).
 */
function CodeChallenge({
  factor,
  hasPasskey,
  onVerified,
}: {
  factor: MfaFactor;
  hasPasskey: boolean;
  onVerified: () => void;
}) {
  const t = useT();
  const verify = useVerifyMfa();
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isTotpCodeComplete(code)) return;
    setError(null);
    verify.mutate(
      { factorId: factor.id, code: normalizeTotpCode(code) },
      {
        onSuccess: onVerified,
        onError: (cause) => setError(t(secondFactorErrorKey(cause))),
      },
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="flex items-center gap-3 rounded-lg border-(length:--border-w) px-3 py-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
          <Smartphone className="size-4" aria-hidden="true" />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <p className="text-sm leading-5 font-semibold">
            {t("staffAuth.verify.factorLabel")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("staffAuth.mfa.totpLabel")}
          </p>
        </div>
      </div>

      {hasPasskey && (
        <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("staffAuth.verify.passkeyHint")}
        </p>
      )}

      <FormField
        label={t("staffAuth.verify.codeLabel")}
        hint={t("staffAuth.verify.codeHint")}
        error={error ?? undefined}
        required
      >
        <Input
          value={code}
          onChange={(event) => setCode(normalizeTotpCode(event.target.value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          className="max-w-40 text-center font-mono text-lg tracking-[0.3em] tabular"
        />
      </FormField>

      <Button
        type="submit"
        loading={verify.isPending}
        disabled={!isTotpCodeComplete(code)}
      >
        <ShieldCheck aria-hidden="true" />
        {t("staffAuth.verify.submit")}
      </Button>
    </form>
  );
}

/**
 * Second-factor step of the staff web login (PRD §3 F6 "Staf — Login Web",
 * AUTH-05). Reached from the area gate or straight after sign-in; a verified
 * session continues to `returnTo`, never back into a login path.
 */
export function MfaVerifyPage({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const auth = useCurrentAuth();
  const state = auth.data ? secondFactorState(auth.data, new Date()) : null;

  function continueToDashboard() {
    toast({ title: t("staffAuth.verify.success"), tone: "success" });
    void navigate({ to: asAppPath(returnTo ?? "/kelola"), replace: true });
  }

  const totpFactor = auth.data?.mfaFactors.find(
    (factor) => factor.type === "totp",
  );
  const passkey = auth.data?.mfaFactors.find(
    (factor) => factor.type === "passkey",
  );
  const identity = primaryIdentity(auth.data?.identities ?? []);
  const noSession =
    auth.isError && auth.error instanceof ApiError && auth.error.status === 401;

  return (
    <ThemeScope
      density="padat"
      className="grid min-h-dvh grid-rows-[auto_1fr_auto]"
    >
      <header className="flex items-center justify-between gap-3 px-gutter py-4">
        <p className="text-base leading-6 font-bold tracking-tight">
          {t("app.defaultBrand")}
        </p>
        <ThemeToggle />
      </header>

      <main
        id="main-content"
        className="mx-auto grid w-full max-w-md place-items-center px-gutter py-6"
      >
        {auth.isPending ? (
          <Card aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-11 w-full" />
          </Card>
        ) : auth.isError ? (
          <Card>
            {noSession ? (
              <EmptyState
                icon={LogIn}
                title={t("staffAuth.verify.noSessionTitle")}
                description={t("staffAuth.verify.noSessionHint")}
                action={
                  <Button asChild>
                    <Link to="/masuk">
                      {t("staffAuth.verify.backToSignIn")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <ErrorState
                title={
                  auth.error instanceof ApiError &&
                  auth.error.code === "NETWORK_ERROR"
                    ? t("staffAuth.verify.offlineTitle")
                    : t("staffAuth.verify.loadErrorTitle")
                }
                description={
                  auth.error instanceof ApiError &&
                  auth.error.code === "NETWORK_ERROR"
                    ? t("staffAuth.verify.offlineHint")
                    : t("staffAuth.verify.loadErrorHint")
                }
                onRetry={() => void auth.refetch()}
              />
            )}
          </Card>
        ) : state === null ? null : state.ended ? (
          <Card>
            <EmptyState
              icon={LogIn}
              title={t("staffAuth.verify.noSessionTitle")}
              description={t("staffAuth.verify.noSessionHint")}
              action={
                <Button asChild>
                  <Link to="/masuk">{t("staffAuth.verify.backToSignIn")}</Link>
                </Button>
              }
            />
          </Card>
        ) : state.verified ? (
          <Card>
            <EmptyState
              icon={CircleCheck}
              title={t("staffAuth.verify.alreadyTitle")}
              description={t("staffAuth.verify.alreadyHint")}
              action={
                <Button asChild>
                  <Link to={asAppPath(returnTo ?? "/kelola")}>
                    {t("staffAuth.verify.continue")}
                  </Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <h1 className="text-xl leading-7 font-semibold">
                {state.enrollmentRequired
                  ? t("staffAuth.verify.enrollTitle")
                  : t("staffAuth.verify.title")}
              </h1>
              <CardDescription>
                {state.enrollmentRequired
                  ? t("staffAuth.verify.enrollHint")
                  : t("staffAuth.verify.description")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-0.5">
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("staffAuth.verify.signedInAs", {
                    name: auth.data?.user.displayName ?? "",
                  })}
                </p>
                {identity && (
                  <p className="text-xs leading-4 text-muted-foreground">
                    {t("staffAuth.verify.identityHint", {
                      value: identity.valueMasked,
                    })}
                  </p>
                )}
              </div>

              {state.enrollmentRequired || !totpFactor ? (
                state.enrollmentRequired ? (
                  <TotpEnrollFlow onEnrolled={continueToDashboard} />
                ) : (
                  <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
                    <KeyRound
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    {t("staffAuth.verify.passkeyHint")}
                  </p>
                )
              ) : (
                <CodeChallenge
                  factor={totpFactor}
                  hasPasskey={passkey !== undefined}
                  onVerified={continueToDashboard}
                />
              )}

              <div className="flex items-start gap-3 rounded-lg border border-dashed p-3">
                <Info
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="grid gap-0.5">
                  <p className="text-sm leading-5 font-semibold">
                    {t("staffAuth.verify.helpTitle")}
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("staffAuth.verify.helpHint")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      <footer className="border-t px-gutter py-4">
        <p className="mx-auto max-w-md text-center text-sm leading-5 text-muted-foreground">
          {t("staffAuth.verify.notYou")}{" "}
          <Link
            to="/masuk"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            {t("staffAuth.verify.backToSignIn")}
          </Link>
        </p>
      </footer>
    </ThemeScope>
  );
}
