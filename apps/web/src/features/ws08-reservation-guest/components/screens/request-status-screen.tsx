// Guest manage page: status of the reschedule request (bead legend-g12il,
// states "pending", "approved", "rejected").
//
// legend-z5ygw: the server only returns a `pending` request today. The
// `approved` and `declined` branches follow the schema and are fed by the
// mock until the contract carries the decision.
import type { ReactNode } from "react";
import type { GuestReservationView } from "@starter/shared/reservation";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { ReservationSummary } from "../reservation-summary";
import { StatusPill } from "../status-pill";
import { guestHeading, guestHint, guestTitle } from "../typography";
import {
  clockLabel,
  dayLabel,
  scheduleLabel,
  useFocusHeading,
} from "./screen-helpers";

export function RequestStatusScreen({
  view,
  timeZone,
  onViewDetail,
}: {
  view: GuestReservationView;
  timeZone: string;
  onViewDetail: () => void;
}) {
  const t = useT();
  const headingRef = useFocusHeading();
  const request = view.rescheduleRequest;
  if (!request) return null;
  // legend-z5ygw: `declined` is not returned by the server yet (mock only).
  const kind =
    request.status === "approved"
      ? "approved"
      : request.status === "declined"
        ? "rejected"
        : "pending";
  const requested = scheduleLabel(t, request.requestedFor, timeZone);
  const original = scheduleLabel(t, view.reservedFor, timeZone);

  const header = (
    pill: ReactNode,
    title: string,
    lead: string,
    pending = false,
  ) => (
    <div className="grid gap-3">
      {pill}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className={`${guestTitle} outline-none`}
      >
        {title}
      </h1>
      <p className={guestHint} role={pending ? "status" : undefined}>
        {lead}
      </p>
    </div>
  );

  if (kind === "pending") {
    return (
      <div className="grid gap-5">
        {header(
          <StatusPill tone="neutral">
            {t("reservationGuestRequest.status.pending.pill")}
          </StatusPill>,
          t("reservationGuestRequest.status.pending.title"),
          t("reservationGuestRequest.status.pending.lead"),
        )}
        <section
          aria-labelledby="requested-time"
          className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
        >
          <h2 id="requested-time" className={guestHeading}>
            {t("reservationGuestRequest.status.pending.panelTitle")}
          </h2>
          <dl className="grid gap-2">
            <Row
              label={t("reservationGuestRequest.rows.date")}
              value={dayLabel(request.requestedFor, timeZone)}
            />
            <Row
              label={t("reservationGuestRequest.rows.time")}
              value={clockLabel(request.requestedFor, timeZone)}
            />
            <Row
              label={t("reservationGuestRequest.rows.guests")}
              value={t("reservationGuestRequest.guests", {
                count: request.partySize ?? view.partySize,
              })}
            />
          </dl>
        </section>
        <GuestNote
          tone="info"
          title={t("reservationGuestRequest.status.pending.keepTitle")}
        >
          {t("reservationGuestRequest.status.pending.keepBody", {
            schedule: original,
          })}
        </GuestNote>
        <ReservationSummary view={view} timeZone={timeZone} />
        <p className={guestHint}>
          {t("reservationGuestRequest.status.pending.hint")}
        </p>
        <GuestActions>
          <Button type="button" onClick={onViewDetail}>
            {t("reservationGuestRequest.status.viewDetail")}
          </Button>
        </GuestActions>
      </div>
    );
  }

  if (kind === "approved") {
    return (
      <div className="grid gap-5">
        {header(
          <StatusPill tone="success">
            {t("reservationGuestRequest.status.approved.pill")}
          </StatusPill>,
          t("reservationGuestRequest.status.approved.title"),
          t("reservationGuestRequest.status.approved.lead", {
            schedule: requested,
          }),
        )}
        <ReservationSummary view={view} timeZone={timeZone} />
        {view.deposit.paidIdr > 0 && (
          <GuestNote
            tone="success"
            title={t("reservationGuestRequest.status.approved.depositTitle")}
          >
            {t("reservationGuestRequest.status.approved.depositBody", {
              amount: formatRupiah(view.deposit.paidIdr),
            })}
          </GuestNote>
        )}
        <GuestActions>
          <Button type="button" onClick={onViewDetail}>
            {t("reservationGuestRequest.status.viewLatest")}
          </Button>
        </GuestActions>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {header(
        <StatusPill tone="warning">
          {t("reservationGuestRequest.status.rejected.pill")}
        </StatusPill>,
        t("reservationGuestRequest.status.rejected.title"),
        t("reservationGuestRequest.status.rejected.lead", {
          schedule: requested,
        }),
      )}
      <ReservationSummary view={view} timeZone={timeZone} />
      <GuestNote
        tone="info"
        title={t("reservationGuestRequest.status.rejected.noteTitle")}
      >
        {t("reservationGuestRequest.status.rejected.noteBody")}
      </GuestNote>
      <GuestActions>
        <Button type="button" onClick={onViewDetail}>
          {t("reservationGuestRequest.status.viewDetail")}
        </Button>
      </GuestActions>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}
