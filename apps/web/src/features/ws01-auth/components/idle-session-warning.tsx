import * as React from "react";
import { Clock } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/errors";
import { safeReturnPath } from "@/features/ws01-login/flow";
import { useCurrentAuth, useExtendStaffSession } from "../hooks";
import { idleWarningVisible, minutesUntilExpiry } from "../state";

/**
 * The current time on the client, re-read every `intervalMs`; null during SSR
 * and hydration. The snapshot rounds down to the second so it stays stable
 * within a render while a fresh read still moves the warning forward.
 */
function useClientNow(intervalMs: number): Date | null {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const timer = setInterval(onChange, intervalMs);
      return () => clearInterval(timer);
    },
    [intervalMs],
  );
  const seconds = React.useSyncExternalStore<number | null>(
    subscribe,
    () => Math.floor(Date.now() / 1000),
    () => null,
  );
  return seconds === null ? null : new Date(seconds * 1000);
}

/**
 * "Sesi akan berakhir" (PRD §3 F6: a management session ends after 30 idle
 * minutes). Mounted once in the management shell, so it warns on every
 * management screen. It fails silent: without identity data (or before the API
 * serves it) it renders nothing.
 */
export function IdleSessionWarning() {
  const t = useT();
  // No background polling (Opus review, legend-9bh): the API's identity
  // middleware records activity on authenticated requests, so a timer that
  // re-reads the session every 30 s would keep an unattended tab alive and the
  // 30-minute idle end (§3 F6) would never come. The view refreshes on real
  // activity instead: each navigation, and the "stay" button.
  const auth = useCurrentAuth();
  const extend = useExtendStaffSession();
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const [stayFailed, setStayFailed] = React.useState(false);
  const { refetch } = auth;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const firstPath = React.useRef(true);
  React.useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    void refetch();
  }, [pathname, refetch]);

  // Client-only clock: the server has no user activity to measure, and a
  // rendered date during SSR would hydrate with a different minute.
  const now = useClientNow(15_000);

  const session = auth.data?.session;
  if (!session || !now) return null;
  if (!idleWarningVisible({ session, now, dismissedFor })) return null;

  async function stay() {
    setStayFailed(false);
    try {
      await extend.mutateAsync();
      await refetch({ throwOnError: true });
      setDismissedFor(session?.expiresAt ?? null);
    } catch (error) {
      // AUTH-05: an ended session (idle, revoked, expired) cannot be revived;
      // send the user to sign-in and back here. Other failures keep the
      // warning open with an error so the user can retry.
      if (error instanceof ApiError && error.status === 401)
        void navigate({
          to: "/masuk",
          search: { lanjut: safeReturnPath(pathname) },
          replace: true,
        });
      else setStayFailed(true);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setDismissedFor(session?.expiresAt ?? null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-5 text-warning" aria-hidden="true" />
            {t("staffAuth.idle.title")}
          </DialogTitle>
          <DialogDescription>
            {t("staffAuth.idle.description")}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-5 font-semibold tabular">
          {t("staffAuth.idle.minutesLeft", {
            minutes: minutesUntilExpiry(session, now),
          })}
        </p>
        {stayFailed && (
          <p role="alert" className="text-sm text-destructive">
            {t("staffAuth.idle.extendFailed")}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setDismissedFor(session.expiresAt)}
          >
            {t("staffAuth.idle.dismiss")}
          </Button>
          <Button onClick={() => void stay()} loading={extend.isPending}>
            {t("staffAuth.idle.stay")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
