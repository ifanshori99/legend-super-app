import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Clock, RotateCw, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { QrCode } from "@/components/ui/qr-code";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnlineStatus } from "@/features/ws06-inventory/hpp-hooks";
import { useMemberQrToken } from "../hooks";
import { formatCountdown, resolveQrTokenView, secondsLeft } from "../qr-token";

type QrRequest = { orderId: string; points: number };

// 1150: the member shows this QR to the cashier. The token is single-use and
// lives 120 s, so the dialog mints one when it opens and again only on an
// explicit "Minta QR baru". The body is mounted only while open, so closing
// stops the clock and a reopen starts from a fresh token.
export function QrTokenDialog({
  open,
  onOpenChange,
  request,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional order and points to bind the token to; omitted = plain member QR. */
  request?: QrRequest;
  /** The button that opens the dialog; focus returns to it on close. */
  trigger: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent hideClose>
        <DialogHeader>
          <DialogTitle>{t("member.qr.title")}</DialogTitle>
          <DialogDescription>
            {request
              ? t("member.qr.descriptionOrder")
              : t("member.qr.description")}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <QrTokenBody request={request} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// Same footprint in every state so the dialog never jumps while it loads:
// a square plate, two reserved text lines, and one action slot.
const PLATE =
  "flex size-56 items-center justify-center rounded-container motion-reduce:animate-none";
const TEXT =
  "grid min-h-24 content-start justify-items-center gap-1 text-center";
const ACTION = "flex min-h-11 w-full items-center justify-center";
// Under this many seconds the ready QR also says, in words, that it is ending.
const WARN_SECONDS = 15;

function QrTokenBody({
  request,
  onClose,
}: {
  request?: QrRequest;
  onClose: () => void;
}) {
  const t = useT();
  const online = useOnlineStatus();
  const mint = useMemberQrToken();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const started = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const token = mint.data;

  function renew() {
    // The pressed button unmounts when the view changes; park focus on the
    // persistent status region first so it is not lost.
    statusRef.current?.focus();
    setNowMs(Date.now());
    mint.mutate(request);
  }

  // One mint per open (the ref survives a StrictMode effect replay).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mint.mutate(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mint once on mount
  }, []);

  // Tick once a second while a token is on screen; the interval runs until
  // unmount or a new token. Timers are throttled in background tabs, so also
  // re-read the clock when the tab becomes visible or the window regains focus.
  const expiresAt = token?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setNowMs(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    const id = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", tick);
    };
  }, [expiresAt]);

  const view = resolveQrTokenView({
    token,
    pending: mint.isPending,
    failed: mint.isError,
    online,
    nowMs,
  });
  const remaining = token ? secondsLeft(token.expiresAt, nowMs) : 0;
  const ending = remaining > 0 && remaining <= WARN_SECONDS;

  return (
    <div className="grid justify-items-center gap-4">
      {/* One polite live region for the whole body: a state change swaps the
          text inside and is announced once. The ticking timer opts out. */}
      <div
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="grid justify-items-center gap-3 outline-none"
      >
        {view === "loading" && (
          <>
            <Skeleton className={PLATE} />
            <div className={TEXT}>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("member.qr.loading")}
              </p>
            </div>
          </>
        )}

        {view === "ready" && token && (
          <>
            <div className={PLATE}>
              <QrCode
                value={token.token}
                label={t("member.qr.qrLabel")}
                size={204}
                className="rounded-container border p-2"
              />
            </div>
            <div className={TEXT}>
              <p
                role="timer"
                aria-live="off"
                className="text-lg leading-7 font-semibold tabular"
              >
                {t("member.qr.countdown", { time: formatCountdown(remaining) })}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("member.qr.onceHint")}
              </p>
              {ending && (
                <p className="text-sm leading-5 font-semibold">
                  {t("member.qr.endingSoon")}
                </p>
              )}
            </div>
          </>
        )}

        {view === "expired" && (
          <StatusPanel
            icon={<Clock className="size-8" aria-hidden="true" />}
            title={t("member.qr.expiredTitle")}
            body={t("member.qr.expiredBody")}
          />
        )}

        {view === "error" && (
          <StatusPanel
            icon={
              <CircleAlert className="size-8 text-danger" aria-hidden="true" />
            }
            title={t("member.qr.errorTitle")}
            body={t("member.qr.errorBody")}
          />
        )}

        {view === "offline" && (
          <StatusPanel
            icon={
              <WifiOff className="size-8 text-warning" aria-hidden="true" />
            }
            title={t("member.qr.offlineTitle")}
            body={t("member.qr.offlineBody")}
          />
        )}
      </div>

      <div className={ACTION}>
        {view !== "loading" && view !== "ready" && (
          <Button className="min-h-11 w-full sm:w-auto" onClick={renew}>
            <RotateCw aria-hidden="true" />
            {view === "expired" ? t("member.qr.renew") : t("member.qr.retry")}
          </Button>
        )}
      </div>

      <Button variant="outline" className="min-h-11 w-full" onClick={onClose}>
        {t("member.qr.close")}
      </Button>
    </div>
  );
}

function StatusPanel({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <>
      <div className={`${PLATE} bg-muted text-muted-foreground`}>{icon}</div>
      <div className={TEXT}>
        <p className="font-semibold">{title}</p>
        <p className="text-sm leading-5 text-muted-foreground">{body}</p>
      </div>
    </>
  );
}
