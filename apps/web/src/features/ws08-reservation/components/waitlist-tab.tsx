// Walk-in waitlist (PRD §3.22 "Waitlist Walk-in"): the queue ordered by who
// waited longest, the quoted estimate, the call action (browser notification)
// and seating from the floor plan. Status names come from the contract.
import * as React from "react";
import { BellRing, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { WaitlistEntry } from "@starter/shared/reservation";
import { RESERVATION_PAGE_SIZE } from "../api";
import {
  activeWaitlist,
  formatClock,
  reservationErrorKey,
  sortWaitlist,
  waitlistActions,
} from "../lib";
import {
  useCallWaitlistEntry,
  useFloorPlan,
  useResolveWaitlistEntry,
  useWaitlist,
} from "../hooks";
import { SeatWaitlistDialog } from "./seat-waitlist-dialog";
import { WaitlistStatusBadge } from "./status-badges";

/**
 * The call itself is a browser notification (PRD §3.22 "pemanggilan melalui
 * notifikasi browser"). Permission is requested on the first call; a blocked or
 * unsupported notification never blocks the queue update.
 */
function notifyGuest(title: string, body: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  try {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return;
    }
    if (Notification.permission === "default")
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification(title, { body });
      });
  } catch {
    // Private mode or an OS-level block: the toast still confirms the call.
  }
}

function WaitlistRow({
  entry,
  timeZone,
  zoneName,
  busy,
  onCall,
  onSeat,
  onLeave,
  onCancel,
}: {
  entry: WaitlistEntry;
  timeZone: string;
  zoneName: string;
  busy: boolean;
  onCall: () => void;
  onSeat: () => void;
  onLeave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const actions = waitlistActions(entry);
  return (
    <li
      data-waitlist-id={entry.id}
      data-status={entry.status}
      className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-card sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-base font-semibold">
            {entry.name}
          </span>
          <WaitlistStatusBadge status={entry.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <Users className="size-4" aria-hidden="true" />
            {t("reservation.waitlist.pax", { count: entry.pax })}
          </span>
          {[
            t("reservation.waitlist.joined", {
              time: formatClock(entry.joinedAt, timeZone),
            }),
            entry.estimatedWaitMinutes === null
              ? t("reservation.waitlist.estimateUnknown")
              : t("reservation.waitlist.estimate", {
                  minutes: entry.estimatedWaitMinutes,
                }),
            zoneName,
            ...(entry.calledAt
              ? [
                  t("reservation.waitlist.calledAt", {
                    time: formatClock(entry.calledAt, timeZone),
                  }),
                ]
              : []),
          ].map((item) => (
            <span key={item} className="whitespace-nowrap">
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
        {actions.call && (
          <Button
            type="button"
            size="sm"
            loading={busy}
            className="w-full sm:w-auto"
            onClick={onCall}
            aria-label={t("reservation.waitlist.call", { name: entry.name })}
          >
            <BellRing aria-hidden="true" />
            {t("reservation.waitlist.callShort")}
          </Button>
        )}
        {actions.seat && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={busy}
            onClick={onSeat}
          >
            {t("reservation.waitlist.seat")}
          </Button>
        )}
        {actions.leave && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full sm:w-auto"
            disabled={busy}
            onClick={onLeave}
          >
            {t("reservation.waitlist.leave")}
          </Button>
        )}
        {actions.cancel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full text-danger sm:w-auto"
            disabled={busy}
            onClick={onCancel}
          >
            {t("reservation.waitlist.cancel")}
          </Button>
        )}
      </div>
    </li>
  );
}

export function WaitlistTab({
  outletId,
  timeZone,
}: {
  outletId: string;
  timeZone: string;
}) {
  const t = useT();
  const toast = useToast();
  const waitlist = useWaitlist(outletId, { limit: RESERVATION_PAGE_SIZE });
  const floor = useFloorPlan(outletId);
  const call = useCallWaitlistEntry();
  const resolve = useResolveWaitlistEntry();
  const [seatEntry, setSeatEntry] = React.useState<WaitlistEntry | null>(null);

  const zoneName = (zoneId: string | null) =>
    zoneId === null
      ? t("reservation.waitlist.zoneAny")
      : (floor.data?.zones.find((zone) => zone.id === zoneId)?.name ??
        t("reservation.waitlist.zoneAny"));

  const failure = (error: unknown) =>
    toast({
      title: t(reservationErrorKey(error)),
      tone: "danger",
    });

  const callGuest = (entry: WaitlistEntry) => {
    call.mutate(
      { outletId, entryId: entry.id },
      {
        onSuccess: () => {
          toast({
            title: t("reservation.waitlist.callSuccess"),
            tone: "success",
          });
          notifyGuest(
            t("reservation.waitlist.callNotificationTitle"),
            t("reservation.waitlist.callNotificationBody", {
              name: entry.name,
            }),
          );
        },
        onError: failure,
      },
    );
  };

  const release = (entry: WaitlistEntry, resolution: "left" | "cancelled") => {
    resolve.mutate(
      { outletId, entryId: entry.id, resolution },
      {
        onSuccess: () =>
          toast({
            title: t("reservation.waitlist.resolveSuccess"),
            tone: "success",
          }),
        onError: failure,
      },
    );
  };

  if (waitlist.isPending) {
    return (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only" role="status">
          {t("reservation.waitlist.loading")}
        </span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-container" />
        ))}
      </div>
    );
  }

  if (waitlist.error)
    return (
      <ErrorState
        title={t("reservation.waitlist.errorTitle")}
        description={t("reservation.waitlist.errorHint")}
        onRetry={() => void waitlist.refetch()}
      />
    );

  const rows = sortWaitlist(waitlist.data.data);
  const active = activeWaitlist(rows);
  const done = rows.filter(
    (entry) => entry.status !== "waiting" && entry.status !== "called",
  );
  const busyId = call.isPending
    ? call.variables?.entryId
    : resolve.isPending
      ? resolve.variables?.entryId
      : undefined;

  if (rows.length === 0)
    return (
      <EmptyState
        title={t("reservation.waitlist.emptyTitle")}
        description={t("reservation.waitlist.emptyHint")}
      />
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="type-title">{t("reservation.waitlist.queue")}</h2>
        <p className="text-sm text-muted-foreground tabular">
          {t("reservation.waitlist.queueCount", { count: active.length })}
        </p>
      </div>

      {active.length === 0 ? (
        <p className="rounded-container bg-muted p-3 text-sm text-muted-foreground">
          {t("reservation.waitlist.emptyHint")}
        </p>
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {active.map((entry) => (
            <WaitlistRow
              key={entry.id}
              entry={entry}
              timeZone={timeZone}
              zoneName={zoneName(entry.zoneId)}
              busy={busyId === entry.id}
              onCall={() => callGuest(entry)}
              onSeat={() => setSeatEntry(entry)}
              onLeave={() => release(entry, "left")}
              onCancel={() => release(entry, "cancelled")}
            />
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <section className="grid gap-2">
          <h2 className="type-eyebrow text-muted-foreground">
            {t("reservation.waitlist.done")}
          </h2>
          <ul className="grid list-none gap-2 p-0">
            {done.map((entry) => (
              <WaitlistRow
                key={entry.id}
                entry={entry}
                timeZone={timeZone}
                zoneName={zoneName(entry.zoneId)}
                busy={false}
                onCall={() => undefined}
                onSeat={() => undefined}
                onLeave={() => undefined}
                onCancel={() => undefined}
              />
            ))}
          </ul>
        </section>
      )}

      {seatEntry && (
        <SeatWaitlistDialog
          entry={seatEntry}
          onOpenChange={(open) => !open && setSeatEntry(null)}
          outletId={outletId}
          timeZone={timeZone}
        />
      )}
    </div>
  );
}
