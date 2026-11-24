import { useState, type FormEvent } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { endActingStaffMode } from "@/lib/api/acting-staff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { siteConfig } from "@/config/site";
import { postLoginPath } from "@/lib/areas/post-login";
import { hrisKeys } from "@/features/ws10-hris-employee/queries";
import { usePasswordResetEnabled } from "@/features/ws01-login/hooks";
import { useT } from "@/components/i18n";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const signingUp = mode === "sign-up";
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const t = useT();
  // Hidden unless the API says it can send the reset mail (SMTP set up).
  const canReset = usePasswordResetEnabled() === true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const credentials = {
        email: String(data.get("email")).trim(),
        password: String(data.get("password")),
      };
      const result = signingUp
        ? await authClient.signUp.email({
            ...credentials,
            name: String(data.get("name")).trim(),
          })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        setError(
          signingUp
            ? result.error.message ||
                "We couldn't create your account. Please try again."
            : "We couldn't sign you in. Check your email and password and try again.",
        );
        return;
      }
      // A new login starts without the previous one's POS cashier hold.
      endActingStaffMode();
      // A different account may sign in on this tab: drop the employee data
      // cached for whoever used it before.
      queryClient.removeQueries({ queryKey: hrisKeys.all });
      // Re-run route guards with the new cookie, then move to the app.
      await router.invalidate();
      // The root context now holds the new session's access.
      const access = router.state.matches[0]?.context.access;
      await navigate({
        to: access ? postLoginPath(access) : siteConfig.appHomePath,
        replace: true,
      });
    } catch {
      setError(
        "We couldn't reach the server. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <p className="mb-3 text-sm font-medium text-primary">
        {signingUp ? "A place to begin" : "Good to see you"}
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {signingUp ? "Create your account" : "Welcome back"}
      </h1>
      <p className="mt-3 text-base leading-7 text-muted-foreground">
        {signingUp
          ? "One small step. Then make this app your own."
          : "Sign in to pick up where you left off."}
      </p>
      <form
        onSubmit={onSubmit}
        className="mt-8 space-y-5"
        aria-busy={pending}
        aria-describedby={error ? "auth-error" : undefined}
      >
        <fieldset disabled={pending} className="space-y-5">
          <legend className="sr-only">
            {signingUp ? "Account details" : "Sign in details"}
          </legend>
          {signingUp && (
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                placeholder="Your name"
                required
                minLength={1}
                maxLength={100}
                pattern=".*\S.*"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              maxLength={254}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              required
              minLength={8}
              maxLength={128}
              aria-describedby={signingUp ? "password-hint" : undefined}
            />
            {!signingUp && canReset && (
              <Link
                className="inline-block rounded-sm text-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                to="/forgot-password"
              >
                {t("login.resetPassword.link")}
              </Link>
            )}
            {signingUp && (
              <p id="password-hint" className="text-sm text-muted-foreground">
                Use at least 8 characters.
              </p>
            )}
          </div>
          {error && (
            <p
              id="auth-error"
              role="alert"
              className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm leading-6 text-destructive"
            >
              {error}
            </p>
          )}
          <Button className="w-full" type="submit" size="lg" disabled={pending}>
            {pending ? (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {pending
              ? "Please wait…"
              : signingUp
                ? "Create account"
                : "Sign in"}
            {!pending && <ArrowRight aria-hidden="true" />}
          </Button>
        </fieldset>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        {signingUp ? "Already have an account?" : "New here?"}{" "}
        <Link
          className="rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
          to={signingUp ? "/sign-in" : "/sign-up"}
        >
          {signingUp ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
