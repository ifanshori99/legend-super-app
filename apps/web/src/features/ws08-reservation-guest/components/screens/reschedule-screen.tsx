// Guest manage page: reschedule request form (bead legend-g12il, states
// "reschedule", "validation", "submitting"). Sends a request only: staff
// decide, and the booking and DP stay as they are until then.
import * as React from "react";
import type {
  GuestRescheduleResult,
  GuestReservationView,
} from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_DURATION,
  MAX_NOTE,
  MAX_PAX,
  formatClock,
} from "@/features/ws08-reservation-customer/lib";
import { useAvailability } from "@/features/ws08-reservation-customer/hooks";
import { useRequestGuestReschedule } from "../../hooks";
import {
  guestErrorKind,
  rescheduleDateBounds,
  validateReschedule,
  zoneLabel,
  type GuestErrorKind,
  type RescheduleProblem,
} from "../../lib";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { ReservationSummary } from "../reservation-summary";
import { StatusPill } from "../status-pill";
import { guestBody, guestHeading, guestHint, guestTitle } from "../typography";
import {
  clockLabel,
  dayLabel,
  scheduleLabel,
  useFocusHeading,
} from "./screen-helpers";

const TIME_ERROR_ID = "requested-time-error";
// Labels on this form: bold 16px, "(opsional)" bold muted (mockup).
const FIELD_LABEL =
  "[&_label]:text-base [&_label]:font-bold [&_label_span]:font-bold";

export function RescheduleScreen({
  view,
  timeZone,
  token,
  onBack,
  onSubmitted,
  onLate,
}: {
  view: GuestReservationView;
  timeZone: string;
  token: string;
  onBack: () => void;
  onSubmitted: (result: GuestRescheduleResult) => void;
  onLate: () => void;
}) {
  const t = useT();
  const headingRef = useFocusHeading();
  const zone = zoneLabel(timeZone);
  const reschedule = useRequestGuestReschedule(token);

  // The screen only mounts after the reservation has loaded in the browser,
  // so reading the clock here cannot differ between server and client.
  const [mountedAt] = React.useState(() => new Date());
  const bounds = rescheduleDateBounds(mountedAt, timeZone);

  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [note, setNote] = React.useState("");
  const [problem, setProblem] = React.useState<RescheduleProblem | null>(null);
  const [failure, setFailure] = React.useState<Exclude<
    GuestErrorKind,
    "late"
  > | null>(null);
  const [requestedFor, setRequestedFor] = React.useState<string | null>(null);
  // Counts rejected submits so a second rejection with the same problem still
  // moves focus (the problem value alone would not change).
  const [attempt, setAttempt] = React.useState(0);

  // Hours come from the public availability when it answers; the guest never
  // sees a made-up slot. Without an answer the field is a plain time input.
  const availability = useAvailability(view.outletId, {
    date,
    pax: Math.min(Math.max(view.partySize, 1), MAX_PAX),
    durationMinutes: DEFAULT_DURATION,
  });
  const slotTimes = React.useMemo(() => {
    const times = (availability.data?.slots ?? [])
      .slice()
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map((slot) => formatClock(slot.startsAt, timeZone).replace(".", ":"));
    return [...new Set(times)];
  }, [availability.data, timeZone]);

  // The heading is remounted when the form swaps with the submitting view and
  // back, and it names the problem after a rejection: refocus it on each
  // pending change and each rejected submit (validation or server).
  const isPending = reschedule.isPending;
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    // The page effect focuses the heading on mount; only refocus on changes.
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [isPending, attempt, headingRef]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const check = validateReschedule({ date, time }, new Date(), timeZone);
    setProblem(null);
    setFailure(null);
    if (!check.ok) {
      setProblem(check.problem);
      setAttempt((count) => count + 1);
      return;
    }
    setRequestedFor(check.requestedFor);
    const trimmed = note.trim();
    reschedule.mutate(
      {
        requestedFor: check.requestedFor,
        ...(trimmed === "" ? {} : { note: trimmed }),
      },
      {
        onSuccess: (result) => onSubmitted(result),
        onError: (error) => {
          const kind = guestErrorKind(error);
          if (kind === "late") {
            onLate();
            return;
          }
          setFailure(kind);
          setAttempt((count) => count + 1);
        },
      },
    );
  };

  const original = scheduleLabel(t, view.reservedFor, timeZone);
  const dateProblem =
    problem === "missing_date" || problem === "past" || problem === "too_far"
      ? problem
      : null;
  const timeProblem = problem === "missing_time" ? problem : null;

  if (reschedule.isPending && requestedFor) {
    return (
      <div className="grid gap-5">
        <div className="grid gap-3">
          <StatusPill tone="neutral">
            {t("reservationGuestRequest.submitting.pill")}
          </StatusPill>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className={`${guestTitle} outline-none`}
          >
            {t("reservationGuestRequest.submitting.title")}
          </h1>
          <p className={guestHint}>
            {t("reservationGuestRequest.submitting.lead")}
          </p>
        </div>
        <section
          aria-labelledby="sending-heading"
          className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
        >
          <h2 id="sending-heading" className={guestHeading}>
            {t("reservationGuestRequest.submitting.panelTitle")}
          </h2>
          <dl className="grid gap-2">
            <Row
              label={t("reservationGuestRequest.rows.date")}
              value={dayLabel(requestedFor, timeZone)}
            />
            <Row
              label={t("reservationGuestRequest.rows.time")}
              value={clockLabel(requestedFor, timeZone)}
            />
            <Row
              label={t("reservationGuestRequest.rows.guests")}
              value={t("reservationGuestRequest.guests", {
                count: view.partySize,
              })}
            />
          </dl>
          <p role="status" className={guestBody}>
            {t("reservationGuestRequest.submitting.status")}
          </p>
        </section>
        <GuestNote
          tone="info"
          title={t("reservationGuestRequest.submitting.keepTitle")}
        >
          {t("reservationGuestRequest.submitting.keepBody", {
            schedule: original,
          })}
        </GuestNote>
        <GuestActions>
          <Button
            type="button"
            disabled
            aria-disabled="true"
            className="bg-muted text-muted-foreground opacity-100 shadow-none disabled:opacity-100"
          >
            {t("reservationGuestRequest.submitting.button")}
          </Button>
        </GuestActions>
      </div>
    );
  }

  return (
    <form className="grid gap-5" onSubmit={submit} noValidate>
      <div className="grid gap-3">
        {problem ? (
          <StatusPill tone="warning">
            {t("reservationGuestRequest.validation.pill")}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">
            {t("reservationGuestRequest.reschedule.pill")}
          </StatusPill>
        )}
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`${guestTitle} outline-none`}
        >
          {problem === "past"
            ? t("reservationGuestRequest.validation.titlePast")
            : problem
              ? t("reservationGuestRequest.validation.title")
              : t("reservationGuestRequest.reschedule.title")}
        </h1>
        <p className={guestHint}>
          {problem === "past"
            ? t("reservationGuestRequest.validation.leadPast")
            : problem
              ? t("reservationGuestRequest.validation.lead")
              : t("reservationGuestRequest.reschedule.lead", {
                  count: view.partySize,
                })}
        </p>
      </div>
      {!problem && <ReservationSummary view={view} timeZone={timeZone} />}

      <section
        aria-labelledby="new-time-heading"
        className="grid gap-5 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
      >
        <h2 id="new-time-heading" className={guestHeading}>
          {t("reservationGuestRequest.reschedule.panelTitle")}
        </h2>
        <FormField
          className={FIELD_LABEL}
          label={t("reservationGuestRequest.reschedule.dateLabel")}
          required
          hint={t("reservationGuestRequest.reschedule.dateHint")}
          error={
            dateProblem
              ? t(`reservationGuestRequest.validation.${dateProblem}`)
              : undefined
          }
        >
          <Input
            name="requested-date"
            type="date"
            value={date}
            min={bounds.min}
            max={bounds.max}
            autoComplete="off"
            onChange={(event) => {
              setDate(event.target.value);
              setTime("");
            }}
          />
        </FormField>

        {slotTimes.length > 0 ? (
          <fieldset
            className="grid gap-2"
            aria-invalid={timeProblem ? true : undefined}
            aria-describedby={timeProblem ? TIME_ERROR_ID : undefined}
          >
            <legend className="mb-1 text-base font-bold">
              {t("reservationGuestRequest.reschedule.timeLegend", { zone })}
            </legend>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slotTimes.map((slot) => (
                <label key={slot} className="relative block">
                  <input
                    type="radio"
                    name="requested-time"
                    value={slot}
                    checked={time === slot}
                    className="peer sr-only"
                    onChange={() => {
                      setTime(slot);
                    }}
                  />
                  <span className="flex h-12 cursor-pointer items-center justify-center rounded-control border-(length:--border-w) border-border bg-background pl-6 font-semibold tabular-nums peer-checked:border-2 peer-checked:border-primary peer-checked:bg-accent peer-checked:font-bold peer-checked:text-primary peer-focus-visible:shadow-focus peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                    {slot.replace(":", ".")}
                  </span>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 rounded-full border-2 border-input bg-background peer-checked:border-primary peer-checked:bg-primary peer-checked:shadow-[inset_0_0_0_2px_var(--color-background)]"
                  />
                </label>
              ))}
            </div>
            {timeProblem ? (
              <p
                id={TIME_ERROR_ID}
                role="alert"
                className="text-sm font-medium text-danger"
              >
                {t("reservationGuestRequest.validation.missing_time")}
              </p>
            ) : (
              <p className={guestHint}>
                {t("reservationGuestRequest.reschedule.timeHint")}
              </p>
            )}
          </fieldset>
        ) : date === "" ? (
          <p className={guestHint}>
            {t("reservationGuestRequest.reschedule.timeDatePrompt")}
          </p>
        ) : availability.isPending ? (
          <div>
            <span role="status" className="sr-only">
              {t("reservationGuestRequest.reschedule.timeLoading")}
            </span>
            <Skeleton className="h-12 rounded-control" />
          </div>
        ) : (
          <FormField
            className={FIELD_LABEL}
            label={t("reservationGuestRequest.reschedule.timeLegend", { zone })}
            required
            hint={t("reservationGuestRequest.reschedule.timeFallbackHint")}
            error={
              timeProblem
                ? t("reservationGuestRequest.validation.missing_time")
                : undefined
            }
          >
            <Input
              name="requested-time"
              type="time"
              step={1800}
              autoComplete="off"
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
              }}
            />
          </FormField>
        )}

        <FormField
          className={FIELD_LABEL}
          label={t("reservationGuestRequest.reschedule.noteLabel")}
          hint={t("reservationGuestRequest.reschedule.noteHint")}
        >
          <Textarea
            name="request-note"
            rows={3}
            maxLength={MAX_NOTE}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </FormField>
      </section>

      {problem ? (
        <p className={guestBody}>
          {t("reservationGuestRequest.validation.keep", {
            schedule: original,
            count: view.partySize,
          })}
        </p>
      ) : (
        <GuestNote
          tone="info"
          title={t("reservationGuestRequest.reschedule.infoTitle")}
        >
          {t("reservationGuestRequest.reschedule.infoBody")}
        </GuestNote>
      )}
      {failure && (
        <div role="alert">
          <GuestNote
            tone="warning"
            title={t("reservationGuestRequest.submitError.title")}
          >
            {t(`reservationGuestRequest.submitError.${failure}`)}
          </GuestNote>
        </div>
      )}

      <GuestActions>
        <Button type="submit">
          {t("reservationGuestRequest.reschedule.submit")}
        </Button>
        <Button type="button" variant="outline" onClick={onBack}>
          {t("reservationGuestRequest.reschedule.back")}
        </Button>
      </GuestActions>
    </form>
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
