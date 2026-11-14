// Guest reschedule requests: a guest asks (from the manage link) to move the
// booking; staff approve, which moves the booking and its table holds, or
// decline, which leaves the booking as it was. A taken table answers 409 and
// the request stays pending. Status names come from the contract.
import { CalendarClock, Users } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { ReservationRescheduleRequest } from "@starter/shared/reservation";
import { RESERVATION_PAGE_SIZE } from "../api";
import { formatDateTime, reservationErrorKey } from "../lib";
import {
  useApproveRescheduleRequest,
  useDeclineRescheduleRequest,
  useRescheduleRequests,
} from "../hooks";
import { RescheduleStatusBadge } from "./status-badges";

function RescheduleRow({
  request,
  timeZone,
  busy,
  onOpen,
  onApprove,
  onDecline,
}: {
  request: ReservationRescheduleRequest;
  timeZone: string;
  busy: boolean;
  onOpen: () => void;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const t = useT();
  const time = formatDateTime(request.requestedFor, timeZone);
  return (
    <li
      data-reschedule-id={request.id}
      data-status={request.status}
      className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-card sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex min-w-0 items-center gap-1 text-base font-semibold">
            <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">
              {t("reservation.reschedule.requestedFor", { time })}
            </span>
          </span>
          <RescheduleStatusBadge status={request.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <Users className="size-4" aria-hidden="true" />
            {request.partySize === null
              ? t("reservation.reschedule.paxSame")
              : t("reservation.reschedule.pax", { count: request.partySize })}
          </span>
        </div>
        {request.note && (
          <p className="text-sm text-muted-foreground">
            {t("reservation.reschedule.note", { note: request.note })}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full sm:w-auto"
          onClick={onOpen}
        >
          {t("reservation.reschedule.open")}
        </Button>
        {request.status === "pending" && (
          <>
            <Button
              type="button"
              size="sm"
              loading={busy}
              className="w-full sm:w-auto"
              onClick={onApprove}
              aria-label={t("reservation.reschedule.approveLabel", { time })}
            >
              {t("reservation.reschedule.approve")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={onDecline}
              aria-label={t("reservation.reschedule.declineLabel", { time })}
            >
              {t("reservation.reschedule.decline")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function RescheduleTab({
  outletId,
  timeZone,
  onOpenReservation,
}: {
  outletId: string;
  timeZone: string;
  onOpenReservation: (reservationId: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const requests = useRescheduleRequests(outletId, {
    limit: RESERVATION_PAGE_SIZE,
  });
  const approve = useApproveRescheduleRequest();
  const decline = useDeclineRescheduleRequest();

  const failure = (error: unknown) =>
    toast({
      title: t(reservationErrorKey(error)),
      tone: "danger",
    });

  const approveRequest = (request: ReservationRescheduleRequest) =>
    approve.mutate(
      { outletId, requestId: request.id },
      {
        onSuccess: () =>
          toast({
            title: t("reservation.reschedule.approveSuccess"),
            tone: "success",
          }),
        onError: failure,
      },
    );

  const declineRequest = (request: ReservationRescheduleRequest) =>
    decline.mutate(
      { outletId, requestId: request.id },
      {
        onSuccess: () =>
          toast({
            title: t("reservation.reschedule.declineSuccess"),
            tone: "success",
          }),
        onError: failure,
      },
    );

  if (requests.isPending) {
    return (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only" role="status">
          {t("reservation.reschedule.loading")}
        </span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-container" />
        ))}
      </div>
    );
  }

  if (requests.error)
    return (
      <ErrorState
        error={requests.error}
        title={t("reservation.reschedule.errorTitle")}
        description={t("reservation.reschedule.errorHint")}
        onRetry={() => void requests.refetch()}
      />
    );

  const rows = requests.data.data;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t("reservation.reschedule.emptyTitle")}
        description={t("reservation.reschedule.emptyHint")}
      />
    );

  // Oldest ask first: the guest who waited longest gets an answer first.
  const pending = rows
    .filter((request) => request.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = rows.filter((request) => request.status !== "pending");
  const busyId = approve.isPending
    ? approve.variables?.requestId
    : decline.isPending
      ? decline.variables?.requestId
      : undefined;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="type-title">{t("reservation.reschedule.pending")}</h2>
        <p className="text-sm text-muted-foreground tabular">
          {t("reservation.reschedule.pendingCount", { count: pending.length })}
        </p>
      </div>

      {pending.length === 0 ? (
        <p className="rounded-container bg-muted p-3 text-sm text-muted-foreground">
          {t("reservation.reschedule.noPending")}
        </p>
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {pending.map((request) => (
            <RescheduleRow
              key={request.id}
              request={request}
              timeZone={timeZone}
              busy={busyId === request.id}
              onOpen={() => onOpenReservation(request.reservationId)}
              onApprove={() => approveRequest(request)}
              onDecline={() => declineRequest(request)}
            />
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <section className="grid gap-2">
          <h2 className="type-eyebrow text-muted-foreground">
            {t("reservation.reschedule.done")}
          </h2>
          <ul className="grid list-none gap-2 p-0">
            {done.map((request) => (
              <RescheduleRow
                key={request.id}
                request={request}
                timeZone={timeZone}
                busy={false}
                onOpen={() => onOpenReservation(request.reservationId)}
                onApprove={() => undefined}
                onDecline={() => undefined}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
