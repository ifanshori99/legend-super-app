// Optional sign-in nudge on QR checkout (bead legend-0rsv; PRD v1.7 §3 F10
// "Login Opsional"). A guest may always order without an account: this card
// only invites sign-in for points, saved favorites and reordering, and the
// guest can dismiss it for this browser session. It never disables or sits
// between the guest and the order actions.
import { useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Gift, X } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { safeReturnPath } from "@/features/ws01-login/flow";

/** Session-scoped: survives a reload, gone when the tab closes. */
export const SIGN_IN_NUDGE_DISMISSED_KEY = "legend-qr-signin-nudge-dismissed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function sessionStorageOrNull(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Pure over an injected storage so a Node test can run it. */
export function readSignInNudgeDismissed(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SIGN_IN_NUDGE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
/** Storage can be blocked (private mode): hide it for this page view too. */
let dismissedInMemory = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type NudgeVisibility = "pending" | "visible" | "dismissed";

function snapshot(): NudgeVisibility {
  return dismissedInMemory || readSignInNudgeDismissed(sessionStorageOrNull())
    ? "dismissed"
    : "visible";
}

function emit() {
  for (const listener of listeners) listener();
}

/**
 * `pending` while the server renders and the browser hydrates: the server
 * cannot read sessionStorage, so the markup must agree with it. A guest who
 * dismissed the nudge therefore never sees it flash back after a reload.
 */
function useNudgeVisibility(): NudgeVisibility {
  return useSyncExternalStore(subscribe, snapshot, () => "pending");
}

export function dismissSignInNudgeForSession() {
  dismissedInMemory = true;
  const storage = sessionStorageOrNull();
  if (storage) {
    try {
      storage.setItem(SIGN_IN_NUDGE_DISMISSED_KEY, "1");
    } catch {
      // Blocked storage: dismissedInMemory still hides it for this view.
    }
  }
  emit();
}

/**
 * The three benefits the PRD names for signing in are listed as text, not
 * icons alone. The return path is checked with `safeReturnPath` here and again
 * by `/masuk`'s `validateSearch`, so it stays app-local (no open redirect).
 * `redirect` is the alias every linking page uses (legend-yoo9).
 */
export function SignInNudge({ returnTo }: { returnTo: string }) {
  const t = useT();
  const visibility = useNudgeVisibility();
  if (visibility !== "visible") return null;
  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold">
            <Gift className="size-4 shrink-0 text-primary" aria-hidden="true" />
            {t("qrCart.checkout.loginTitle")}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("qrCart.checkout.signInNudge.dismiss")}
            onClick={dismissSignInNudgeForSession}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <ul className="grid gap-1.5 text-sm leading-5">
          <li className="flex items-start gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{t("qrCart.checkout.signInNudge.points")}</span>
          </li>
          <li className="flex items-start gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{t("qrCart.checkout.signInNudge.favorites")}</span>
          </li>
          <li className="flex items-start gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{t("qrCart.checkout.signInNudge.reorder")}</span>
          </li>
        </ul>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("qrCart.checkout.signInNudge.guestNote")}
        </p>
        <Button asChild variant="outline" className="w-fit">
          <Link to="/masuk" search={{ redirect: safeReturnPath(returnTo) }}>
            {t("qrCart.checkout.signInNudge.action")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
