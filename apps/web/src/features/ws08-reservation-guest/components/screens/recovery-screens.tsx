// Recovery and terminal screens for the guest page (legend-g12il): invalid
// link, loading, load error, rate limit, and a closed reservation. None of
// them shows reservation detail except ClosedScreen, which only appears once
// the server has returned a valid view.
import type { GuestReservationView } from "@starter/shared/reservation";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GuestActions } from "../guest-actions";
import { GuestNote } from "../guest-note";
import { ReservationSummary } from "../reservation-summary";
import { StatusPill } from "../status-pill";
import { guestHeading, guestHint, guestTitle } from "../typography";
import { useFocusHeading } from "./screen-helpers";

// Light skeleton for this page only (mockup #e9dfd4): the warm paper theme
// reads better than the global dark --skeleton, and the loading text carries
// the state for readers.
const SKELETON_LIGHT = "[--skeleton:#e9dfd4]";

function Heading({ children }: { children: string }) {
  const headingRef = useFocusHeading();
  return (
    <h1 ref={headingRef} tabIndex={-1} className={`${guestTitle} outline-none`}>
      {children}
    </h1>
  );
}

function Lead({ children, alert }: { children: string; alert?: boolean }) {
  return (
    <p role={alert ? "alert" : undefined} className={guestHint}>
      {children}
    </p>
  );
}

export function InvalidLinkScreen() {
  const t = useT();
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="warning">
            {t("reservationGuestCancel.invalid.pill")}
          </StatusPill>
        </div>
        <Heading>{t("reservationGuestCancel.invalid.title")}</Heading>
        <Lead alert>{t("reservationGuestCancel.invalid.lead")}</Lead>
      </header>
      <section
        className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
        aria-labelledby="invalid-help"
      >
        <h2 id="invalid-help" className={guestHeading}>
          {t("reservationGuestCancel.invalid.howHeading")}
        </h2>
        <ol className="grid list-decimal gap-1 pl-5 text-base leading-6">
          <li>{t("reservationGuestCancel.invalid.step1")}</li>
          <li>{t("reservationGuestCancel.invalid.step2")}</li>
          <li>{t("reservationGuestCancel.invalid.step3")}</li>
        </ol>
      </section>
      <p className={guestHint}>{t("reservationGuestCancel.invalid.privacy")}</p>
    </div>
  );
}

export function GuestLoadingScreen() {
  const t = useT();
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <Heading>{t("reservationGuestCancel.loading.title")}</Heading>
        <p role="status" className={guestHint}>
          {t("reservationGuestCancel.loading.lead")}
        </p>
      </header>
      <div className={`grid gap-6 ${SKELETON_LIGHT}`} aria-busy="true">
        <div className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
          <Skeleton className="h-6 w-3/5" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-1/2" />
        </div>
        <Skeleton className="h-26" />
      </div>
    </div>
  );
}

export function GuestLoadErrorScreen({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="warning">
            {t("reservationGuestCancel.error.pill")}
          </StatusPill>
        </div>
        <Heading>{t("reservationGuestCancel.error.title")}</Heading>
        <Lead alert>{t("reservationGuestCancel.error.lead")}</Lead>
      </header>
      <GuestNote
        tone="warning"
        title={t("reservationGuestCancel.error.noteTitle")}
      >
        {t("reservationGuestCancel.error.noteBody")}
      </GuestNote>
      <GuestActions>
        <Button type="button" className="w-full" onClick={onRetry}>
          {t("reservationGuestCancel.error.retry")}
        </Button>
      </GuestActions>
      <p className={`${guestHint} -mt-2`}>
        {t("reservationGuestCancel.error.help")}
      </p>
    </div>
  );
}

export function GuestRateLimitedScreen({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="warning">
            {t("reservationGuestCancel.rateLimit.pill")}
          </StatusPill>
        </div>
        <Heading>{t("reservationGuestCancel.rateLimit.title")}</Heading>
        <Lead alert>{t("reservationGuestCancel.rateLimit.lead")}</Lead>
      </header>
      <GuestNote
        tone="info"
        title={t("reservationGuestCancel.rateLimit.noteTitle")}
      >
        {t("reservationGuestCancel.rateLimit.noteBody")}
      </GuestNote>
      <GuestActions>
        <Button type="button" className="w-full" onClick={onRetry}>
          {t("reservationGuestCancel.rateLimit.retry")}
        </Button>
      </GuestActions>
      <p className={`${guestHint} -mt-2`}>
        {t("reservationGuestCancel.rateLimit.help")}
      </p>
    </div>
  );
}

/** Seated, completed, or no-show: the guest can no longer change anything. */
export function ClosedScreen({
  view,
  timeZone,
}: {
  view: GuestReservationView;
  timeZone: string;
}) {
  const t = useT();
  const copy =
    view.status === "seated"
      ? {
          pill: t("reservationGuestCancel.closed.seatedPill"),
          title: t("reservationGuestCancel.closed.seatedTitle"),
          lead: t("reservationGuestCancel.closed.seatedLead"),
        }
      : view.status === "completed"
        ? {
            pill: t("reservationGuestCancel.closed.completedPill"),
            title: t("reservationGuestCancel.closed.completedTitle"),
            lead: t("reservationGuestCancel.closed.completedLead"),
          }
        : view.status === "no_show"
          ? {
              pill: t("reservationGuestCancel.closed.noShowPill"),
              title: t("reservationGuestCancel.closed.noShowTitle"),
              lead: t("reservationGuestCancel.closed.noShowLead"),
            }
          : {
              pill: t("reservationGuestCancel.closed.otherPill"),
              title: t("reservationGuestCancel.closed.otherTitle"),
              lead: t("reservationGuestCancel.closed.otherLead"),
            };
  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <StatusPill tone="neutral">{copy.pill}</StatusPill>
        </div>
        <Heading>{copy.title}</Heading>
        <Lead>{copy.lead}</Lead>
      </header>
      <ReservationSummary view={view} timeZone={timeZone} />
      <p className={guestHint}>{t("reservationGuestCancel.closed.help")}</p>
    </div>
  );
}
