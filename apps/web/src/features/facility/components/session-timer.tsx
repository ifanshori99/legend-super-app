// Session timer of the access ticket (PRD §3 F22 "Sesi & Pengingat").
//
// The countdown runs on the server's clock: the first render uses the view's
// `serverTime` (so SSR and hydration agree) and after mount it advances with
// the time this tab has been open. The device clock is never trusted, because
// a guest can change it.
//
// `sessionTimerState` is shared with the tests; the 5-minute reminder is this
// screen's job while it is open (the banner below, no toast on top of it). Web push delivery is WS-06 (bead follow-up).
import { useEffect, useState } from "react";
import { AlarmClock } from "lucide-react";
import type { AccessTicketView } from "@starter/shared/facility";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { cn } from "cn";
import {
  formatClock,
  formatCountdown,
  remainingMs,
  sessionProgress,
  sessionTimerState,
} from "../flow";

const MINUTE_MS = 60_000;

export function SessionTimer({
  view,
  className,
}: {
  view: AccessTicketView;
  className?: string;
}) {
  const t = useT();
  const [mountedAt] = useState(() => Date.now());
  // First render: the documented server instant, identical on server and client.
  const [now, setNow] = useState(() => Date.parse(view.serverTime));

  useEffect(() => {
    const tick = () =>
      setNow(Date.parse(view.serverTime) + (Date.now() - mountedAt));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [view.serverTime, mountedAt]);

  const doorWindow = view.credentialWindow;
  const state = sessionTimerState({
    now,
    startsAt: doorWindow.validFrom,
    endsAt: view.session.scheduledEndsAt,
    endedAt: view.session.endedAt,
  });

  const opensIn = Date.parse(doorWindow.validFrom) - now;
  const remaining = remainingMs(now, view.session.scheduledEndsAt);
  const overtimeMinutes =
    state === "overtime"
      ? Math.ceil((now - Date.parse(view.session.scheduledEndsAt)) / MINUTE_MS)
      : 0;
  const progress = sessionProgress({
    now,
    startsAt: doorWindow.validFrom,
    endsAt: view.session.scheduledEndsAt,
  });

  const label =
    state === "before"
      ? t("facility.ticket.windowOpens", {
          from: formatClock(doorWindow.validFrom),
        })
      : state === "overtime"
        ? t("facility.ticket.overtime", { minutes: overtimeMinutes })
        : state === "ended"
          ? t("facility.ticket.session")
          : t("facility.ticket.remaining");

  const value =
    state === "before"
      ? opensIn > 0 && opensIn < 60 * MINUTE_MS
        ? formatCountdown(opensIn)
        : formatClock(doorWindow.validFrom)
      : state === "ended"
        ? view.session.endedAt === null
          ? "—"
          : formatClock(view.session.endedAt)
        : state === "overtime"
          ? `${overtimeMinutes}`
          : formatCountdown(remaining);

  const detail =
    state === "before"
      ? t("facility.ticket.window", {
          from: formatClock(doorWindow.validFrom),
          until: formatClock(doorWindow.validUntil),
        })
      : state === "overtime"
        ? t("facility.ticket.overtimeGrace", {
            minutes: view.ticket.graceMinutes,
          })
        : t("facility.ticket.endsAt", {
            time: formatClock(view.session.scheduledEndsAt),
          });

  return (
    <div className={cn("grid gap-3", className)}>
      <div className="grid gap-1">
        <p className="flex items-center gap-1.5 type-eyebrow text-muted-foreground">
          <AlarmClock className="size-3.5" aria-hidden="true" />
          {label}
        </p>
        <p className="type-display tabular" aria-live="off">
          {value}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">{detail}</p>
      </div>
      <div
        aria-hidden="true"
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-(--duration-base) ease-standard"
          style={{ width: `${progress}%` }}
        />
      </div>
      {/* Mounted from the start (empty) so the reminder is announced. */}
      <p role="status" className="sr-only">
        {state === "reminder"
          ? `${t("facility.ticket.reminderTitle")}. ${t("facility.ticket.reminderBody")}`
          : ""}
      </p>
      {state === "reminder" && (
        <p
          aria-hidden="true"
          className="rounded-container bg-warning-subtle px-3 py-2 text-sm leading-5 text-warning"
        >
          <span className="font-semibold">
            {t("facility.ticket.reminderTitle")}.
          </span>{" "}
          {t("facility.ticket.reminderBody")}
        </p>
      )}
      {state === "ended" && view.session.overtimeFeeIdr > 0 && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.ticket.overtime", {
            minutes: view.session.overtimeMinutes,
          })}{" "}
          ·{" "}
          {t("facility.ticket.overtimeFee", {
            amount: formatRupiah(view.session.overtimeFeeIdr),
          })}
        </p>
      )}
    </div>
  );
}
