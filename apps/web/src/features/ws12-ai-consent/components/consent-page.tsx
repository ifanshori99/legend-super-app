// MCP consent screen (legend-39d.1; mockup design/mockups/ai/consent.html).
// Outside every area: the user arrives from an external MCP client through
// GET /oauth/authorize. "Setujui akses" posts to the API and follows
// `redirectTo`; "Tolak" goes to the client's redirect_uri without an API call.
import { useEffect, useState } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleCheck,
  Eye,
  FilePenLine,
  LoaderCircle,
  LogIn,
  TriangleAlert,
  AppWindow,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { siteConfig } from "@/config/site";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { signInPath } from "@/features/ws01-login/flow";
import { useApproveMcpAccess, useMcpPreview } from "../hooks";
import {
  CONSENT_RESUME_KEY,
  buildDenyRedirect,
  buildResumeReturnPath,
  isResumeSearch,
  isSafeNavigationUrl,
  parseConsentQuery,
  pickRawConsentSearch,
  redirectHost,
  type ConsentQuery,
} from "../logic";

type RedirectMode = "approve" | "deny";

// The first navigation entry keeps the query exactly as the browser received
// it; `window.location.search` may already be rewritten by the router.
function readRawSearch(): string {
  const entry = performance.getEntriesByType?.("navigation")[0];
  return pickRawConsentSearch(entry?.name, window.location.search);
}

export function McpConsentPage() {
  const t = useT();
  const session = useRouteContext({ strict: false, select: (c) => c.session });
  const access = useRouteContext({ strict: false, select: (c) => c.access });
  // Mock mode has no real session: the mock role cookie decides, the same way
  // area access does (an unset cookie counts as signed in). Real mode: session.
  const signedIn = API_MOCK ? access?.authenticated === true : !!session;
  // The OAuth values come from the raw address bar, never from the router's
  // search: the router re-serialises JSON-like values (a long `state` number
  // or `1e5` would change). `null` until the browser has read it.
  const [search, setSearch] = useState<string | null>(null);
  const query = search === null ? null : parseConsentQuery(search);
  const preview = useMcpPreview(query);
  const approve = useApproveMcpAccess();
  const { reset: resetApprove } = approve;
  const [redirecting, setRedirecting] = useState<RedirectMode | null>(null);
  const [badRedirect, setBadRedirect] = useState(false);

  const accountName = session?.user.name;

  useEffect(() => {
    const raw = readRawSearch();
    // Back from sign-in: the OAuth query waits in sessionStorage. A signed-out
    // visitor keeps it there for the next sign-in.
    if (!signedIn || !isResumeSearch(raw)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the address bar cannot be read during SSR; reading it after mount keeps hydration identical.
      setSearch(raw);
      return;
    }
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(CONSENT_RESUME_KEY);
      window.sessionStorage.removeItem(CONSENT_RESUME_KEY);
    } catch {
      stored = null;
    }
    if (stored !== null && parseConsentQuery(stored) !== null) {
      window.history.replaceState(
        window.history.state,
        "",
        `/mcp/consent${stored}`,
      );
      setSearch(stored);
    } else {
      setSearch("");
    }
  }, [signedIn]);

  // Back button after leaving for the client app: the page may come back from
  // the bfcache still showing "Menyambungkan...".
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      setRedirecting(null);
      setBadRedirect(false);
      resetApprove();
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [resetApprove]);

  function onSignIn() {
    const raw = readRawSearch();
    let returnTo = buildResumeReturnPath();
    // Already the resume address: the stored query is kept as it is.
    if (!isResumeSearch(raw)) {
      try {
        window.sessionStorage.setItem(CONSENT_RESUME_KEY, raw);
      } catch {
        returnTo = `/mcp/consent${raw}`;
      }
    }
    window.location.assign(signInPath(returnTo));
  }

  function go(href: string, mode: RedirectMode) {
    // A server or client address that would run script here is never followed.
    const absolute = new URL(href, window.location.href).href;
    if (!isSafeNavigationUrl(absolute)) {
      setBadRedirect(true);
      return;
    }
    setBadRedirect(false);
    setRedirecting(mode);
    window.location.assign(absolute);
  }

  function onApprove(q: ConsentQuery) {
    approve.mutate(q, {
      // `redirectTo` may carry `error=` (refusal, MFA missing): always follow.
      onSuccess: ({ redirectTo }) => go(redirectTo, "approve"),
    });
  }

  function onDeny(q: ConsentQuery) {
    // Only the address the server checked for this client is followed.
    const href =
      preview.data?.data.redirectUri === q.redirect_uri
        ? buildDenyRedirect(q)
        : null;
    if (href === null) {
      setBadRedirect(true);
      return;
    }
    go(href, "deny");
  }

  const previewError = preview.error;
  const signedOut =
    !signedIn ||
    (previewError instanceof ApiError && previewError.status === 401) ||
    (approve.error instanceof ApiError && approve.error.status === 401);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="flex h-15 items-center justify-between border-b border-border bg-card px-5 sm:h-18 sm:px-12">
        <span className="text-xl font-bold tracking-tight">
          {t("app.defaultBrand")}
        </span>
        {accountName ? (
          <p className="text-xs text-muted-foreground sm:text-sm">
            <span className="hidden sm:inline">
              {t("aiConsent.accountLead")}{" "}
            </span>
            <strong className="font-semibold text-foreground">
              {accountName}
            </strong>
          </p>
        ) : null}
      </header>

      <main
        id="main-content"
        className="mx-auto max-w-3xl px-4 py-6 sm:px-5 sm:py-10"
      >
        <Link
          to={siteConfig.appHomePath}
          className="mb-4 inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:mb-5"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("aiConsent.back")}
        </Link>

        {redirecting ? (
          <Redirecting mode={redirecting} />
        ) : signedOut ? (
          <Card>
            <EmptyState
              icon={LogIn}
              title={t("aiConsent.signedOutTitle")}
              description={t("aiConsent.signedOutHint")}
              action={
                <Button className="min-h-11" onClick={onSignIn}>
                  {t("aiConsent.signIn")}
                </Button>
              }
            />
          </Card>
        ) : search === null ? (
          <ConsentSkeleton label={t("aiConsent.loading")} />
        ) : query === null ? (
          <Card>
            <EmptyState
              icon={TriangleAlert}
              title={t("aiConsent.missingTitle")}
              description={t("aiConsent.missingHint")}
            />
          </Card>
        ) : (
          <>
            <div className="mb-5 flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-5">
              <div>
                <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
                  {t("aiConsent.eyebrow")}
                </p>
                <h1 className="mt-1.5 mb-2 text-2xl leading-snug font-bold tracking-tight">
                  {t("aiConsent.heading")}
                </h1>
                <p className="text-muted-foreground">{t("aiConsent.intro")}</p>
              </div>
              {preview.data ? (
                <Badge tone="success" className="shrink-0">
                  <CircleCheck aria-hidden="true" />
                  {t("aiConsent.approvedBadge")}
                </Badge>
              ) : null}
            </div>

            {preview.isPending ? (
              <ConsentSkeleton label={t("aiConsent.loading")} />
            ) : preview.isError ? (
              <Card>
                <ErrorState
                  title={t("aiConsent.previewErrorTitle")}
                  description={`${previewError instanceof ApiError ? `${previewError.message} ` : ""}${t("aiConsent.previewErrorHint")}`}
                  onRetry={() => void preview.refetch()}
                />
              </Card>
            ) : (
              <>
                <CardShell>
                  <Card className="gap-0 overflow-hidden p-0">
                    <section className="flex items-center gap-3.5 border-b border-border px-4 py-4.5 sm:px-6">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-surface-3">
                        <AppWindow className="size-5" aria-hidden="true" />
                      </span>
                      <div>
                        <p className="text-lg font-bold">
                          {preview.data.data.clientName}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t("aiConsent.clientKind")}
                        </p>
                        {redirectHost(preview.data.data.redirectUri) ? (
                          <p className="break-words text-sm text-muted-foreground">
                            {t("aiConsent.returnsTo", {
                              host:
                                redirectHost(preview.data.data.redirectUri) ??
                                "",
                            })}
                          </p>
                        ) : null}
                      </div>
                    </section>

                    <section
                      aria-labelledby="consent-scopes"
                      className="border-b border-border px-4 py-4.5 sm:px-6 sm:py-5.5"
                    >
                      <h2 id="consent-scopes" className="text-lg font-semibold">
                        {t("aiConsent.scopesHeading")}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {t("aiConsent.scopesHint")}
                      </p>
                      <ul className="mt-2">
                        {preview.data.data.scopes.map((item) => (
                          <li
                            key={item.scope}
                            className="flex items-start gap-3.5 py-3 not-first:border-t not-first:border-border"
                          >
                            {item.scope.endsWith(":draft") ? (
                              <FilePenLine
                                className="mt-0.5 size-5 shrink-0"
                                aria-hidden="true"
                              />
                            ) : (
                              <Eye
                                className="mt-0.5 size-5 shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <span className="type-heading">{item.label}</span>
                          </li>
                        ))}
                      </ul>
                      {preview.data.data.scopes.some((s) =>
                        s.scope.endsWith(":draft"),
                      ) ? (
                        <p className="mt-3 rounded-lg bg-surface-2 px-4 py-3.5 text-sm">
                          <strong>{t("aiConsent.draftNoticeLead")}</strong>{" "}
                          {t("aiConsent.draftNotice")}
                        </p>
                      ) : null}
                    </section>

                    {accountName ? (
                      <section className="border-b border-border px-4 py-4.5 sm:px-6 sm:py-5.5">
                        <p className="text-sm text-muted-foreground">
                          {t("aiConsent.account")}
                        </p>
                        <p className="text-sm font-semibold">{accountName}</p>
                      </section>
                    ) : null}

                    <div className="flex flex-col items-stretch gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4.5">
                      <p className="text-sm text-muted-foreground">
                        {t("aiConsent.revocable")}
                      </p>
                      <div className="flex flex-col-reverse gap-2.5 sm:flex-row">
                        <Button
                          variant="outline"
                          className="min-h-12 w-full sm:min-h-11 sm:w-auto"
                          disabled={approve.isPending}
                          onClick={() => onDeny(query)}
                        >
                          {t("aiConsent.deny")}
                        </Button>
                        <Button
                          className="min-h-12 w-full sm:min-h-11 sm:w-auto"
                          loading={approve.isPending}
                          onClick={() => onApprove(query)}
                        >
                          {t("aiConsent.approve")}
                        </Button>
                      </div>
                    </div>
                  </Card>
                </CardShell>

                {approve.isError || badRedirect ? (
                  <p
                    role="alert"
                    className="mt-4 flex items-start gap-2 rounded-lg bg-danger-subtle px-4 py-3 text-sm text-danger"
                  >
                    <TriangleAlert
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    {badRedirect
                      ? t("aiConsent.badRedirect")
                      : approve.error instanceof ApiError &&
                          approve.error.status < 500
                        ? approve.error.message
                        : t("aiConsent.authorizeFailed")}
                  </p>
                ) : null}

                <p className="mt-4 text-left text-sm text-muted-foreground sm:text-center">
                  {t("aiConsent.foot")}
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Redirecting({ mode }: { mode: RedirectMode }) {
  const t = useT();
  return (
    <Card role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <LoaderCircle
          className="size-8 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold">
          {mode === "approve"
            ? t("aiConsent.connecting")
            : t("aiConsent.denying")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {mode === "approve"
            ? t("aiConsent.connectingHint")
            : t("aiConsent.denyingHint")}
        </p>
      </div>
    </Card>
  );
}

function ConsentSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        {label}
      </p>
      <CardShell>
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center gap-3.5 border-b border-border px-4 py-4.5 sm:px-6">
            <Skeleton className="size-11" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
          <div className="space-y-4 border-b border-border px-4 py-5 sm:px-6">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-full max-w-sm" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
          </div>
          <div className="flex flex-col gap-2.5 px-4 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Skeleton className="h-12 w-full sm:h-11 sm:w-24" />
            <Skeleton className="h-12 w-full sm:h-11 sm:w-36" />
          </div>
        </Card>
      </CardShell>
    </div>
  );
}
