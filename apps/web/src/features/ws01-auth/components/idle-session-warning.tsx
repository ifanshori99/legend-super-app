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
 * "Sesi akan berakhir" (PRD §3 F6: a management session ends after 30 idle
 * minutes). Mounted once in the management shell, so it warns on every
 * management screen. It fails silent: without identity data (or before the API
 * serves it) it renders nothing.
 */
export function IdleSessionWarning() {
  const t = useT();
  const auth = useCurrentAuth({ refetchInterval: 30_000 });
  const [now, setNow] = React.useState<Date | null>(null);
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const { refetch } = auth;

  // Client-only clock: the server has no user activity to measure, and a
  // rendered date during SSR would hydrate with a different minute.
  React.useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

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
          <DialogDescription>{t("staffAuth.idle.description")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-5 font-semibold tabular">
          {t("staffAuth.idle.minutesLeft", {
            minutes: minutesUntilExpiry(session, now),
          })}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDismissedFor(session.expiresAt)}>
            {t("staffAuth.idle.dismiss")}
          </Button>
          <Button onClick={stay}>{t("staffAuth.idle.stay")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
