import * as React from "react";
import { Clock } from "lucide-react";
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
import { useCurrentAuth } from "../hooks";
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
  const auth = useCurrentAuth({ refetchInterval: 30_000 });
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const { refetch } = auth;

  // Client-only clock: the server has no user activity to measure, and a
  // rendered date during SSR would hydrate with a different minute.
  const now = useClientNow(15_000);

  const session = auth.data?.session;
  if (!session || !now) return null;
  if (!idleWarningVisible({ session, now, dismissedFor })) return null;

  function stay() {
    setDismissedFor(session?.expiresAt ?? null);
    // Any user activity pushes the idle deadline server-side.
    void refetch();
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
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setDismissedFor(session.expiresAt)}
          >
            {t("staffAuth.idle.dismiss")}
          </Button>
          <Button onClick={stay}>{t("staffAuth.idle.stay")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
